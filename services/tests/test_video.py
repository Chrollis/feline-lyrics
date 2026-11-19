"""Tests for the video decoder and the two protocol methods on top of it.

Run with: python -m unittest discover -s services/tests -v
"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from felyrics import runtime
from felyrics.errors import ServiceError
from felyrics.media import methods, video  # noqa: F401  (import registers methods)
from support import call, write_flac, write_video


class VideoTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name)
        self.cache = self.dir / "cache"
        runtime.configure(self.cache)
        self.clip = self.dir / "clip.mp4"
        write_video(self.clip, width=64, height=48, count=3, rate=10)
        self.song = self.dir / "song.flac"
        write_flac(self.song, rate=8000, layout="mono", frames=800)

    def test_probe_reports_the_stream(self):
        info = video.probe(self.clip)

        self.assertEqual((info.width, info.height), (64, 48))
        self.assertEqual(info.fps, 10.0)
        self.assertEqual(info.codec, "mpeg4")
        self.assertAlmostEqual(info.duration, 0.3, delta=0.05)

    def test_frames_decodes_the_requested_count(self):
        shots = list(video.frames(self.clip, start=0.0, step=0.1, count=2))

        self.assertEqual(len(shots), 2)
        self.assertEqual([shot.requested for shot in shots], [0.0, 0.1])
        # 10 fps with a step that divides it: requested and real time agree.
        self.assertEqual([shot.at for shot in shots], [0.0, 0.1])
        self.assertEqual(shots[0].pixels.shape, (48, 64, 3))
        self.assertEqual(shots[0].pixels.dtype.name, "uint8")

    def test_frames_reports_the_frame_time_when_step_misses_a_frame(self):
        # 10 fps has frames at 0.0, 0.1, 0.2; a 0.15 step must answer with the
        # 0.2 frame and say so, instead of labelling it 0.15.
        shots = list(video.frames(self.clip, start=0.0, step=0.15, count=2))

        self.assertEqual([shot.requested for shot in shots], [0.0, 0.15])
        self.assertEqual([round(shot.at, 3) for shot in shots], [0.0, 0.2])

    def test_frames_scales_to_the_asked_width(self):
        shots = list(video.frames(self.clip, count=1, width=32))

        # 64x48 scaled to 32 wide is 24 high: the aspect ratio is kept, not the
        # height the caller happened to imagine.
        self.assertEqual(shots[0].pixels.shape, (24, 32, 3))

    def test_frames_stops_when_the_file_ends(self):
        shots = list(video.frames(self.clip, start=5.0, step=0.1, count=2))

        self.assertEqual(shots, [])

    def test_frames_yields_before_it_has_decoded_the_whole_batch(self):
        # The generator contract is what keeps memory flat: the caller must be
        # able to act on the first still while the rest is still undecoded.
        stream = video.frames(self.clip, step=0.1, count=3)
        first = next(stream)

        self.assertEqual(first.requested, 0.0)
        stream.close()

    def test_a_file_without_video_is_named_as_such(self):
        audio_only = self.dir / "music.flac"
        write_flac(audio_only, rate=8000, layout="mono", frames=800)

        with self.assertRaises(ServiceError) as caught:
            video.probe(audio_only)

        self.assertEqual(caught.exception.code, "media/no-video-stream")

    def test_frames_method_writes_one_png_per_still(self):
        response = call(
            "video/frames", {"path": str(self.clip), "step": 0.1, "count": 2}
        )
        result = response["result"]

        self.assertEqual(len(result["frames"]), 2)
        self.assertEqual((result["width"], result["height"]), (64, 48))
        self.assertEqual(Path(result["dir"]).parent, self.cache / "jobs" / "frames")

        for entry in result["frames"]:
            written = Path(entry["path"])

            self.assertTrue(written.is_file())
            self.assertEqual(written.read_bytes()[:8], b"\x89PNG\r\n\x1a\n")

    def test_the_method_writes_each_png_before_the_next_frame_arrives(self):
        # Streaming, not "collect then write": by the time the consumer asks for
        # the second frame, the first one is already a file on disk.
        on_disk = []

        def dying(*args, **kwargs):
            yield video.Frame(requested=0.0, at=0.0, pixels=np.zeros((4, 6, 3), np.uint8))
            on_disk.extend(sorted((self.cache / "jobs" / "frames").rglob("*.png")))
            raise RuntimeError("the decoder died")

        with mock.patch.object(methods.video, "frames", dying):
            response = call("video/frames", {"path": str(self.clip), "count": 3})

        self.assertEqual(response["error"]["code"], "internal/error")
        self.assertEqual(len(on_disk), 1)

    def test_a_failed_frame_request_keeps_the_previous_stills(self):
        # A request that dies halfway is a request whose paths nobody received,
        # so the batch it was going to replace must still be on disk.
        call("video/frames", {"path": str(self.clip), "step": 0.1, "count": 2})
        before = sorted((self.cache / "jobs" / "frames").rglob("*.png"))

        def dying(*args, **kwargs):
            yield video.Frame(requested=0.0, at=0.0, pixels=np.zeros((4, 6, 3), np.uint8))
            raise ServiceError("media/decode-failed", "the decoder died")

        with mock.patch.object(methods.video, "frames", dying):
            response = call("video/frames", {"path": str(self.clip), "count": 3})

        self.assertEqual(response["error"]["code"], "media/decode-failed")
        self.assertEqual(sorted((self.cache / "jobs" / "frames").rglob("*.png")), before)
        self.assertEqual(len(list((self.cache / "jobs" / "frames").iterdir())), 1)

    def test_an_empty_frame_request_keeps_the_previous_stills(self):
        # `start` past the end of the clip asks for nothing; it must not wipe the
        # stills the timeline is showing, and it has no directory to hand back.
        call("video/frames", {"path": str(self.clip), "step": 0.1, "count": 2})
        before = sorted((self.cache / "jobs" / "frames").rglob("*.png"))

        result = call(
            "video/frames", {"path": str(self.clip), "start": 5.0, "count": 2}
        )["result"]

        self.assertEqual(result["frames"], [])
        self.assertEqual(result["dir"], "")
        self.assertEqual(sorted((self.cache / "jobs" / "frames").rglob("*.png")), before)

    def test_a_frame_request_keeps_the_decoded_audio(self):
        # The renderer can still be playing the decoded audio while the timeline
        # asks for thumbnails, so each kind of result clears only its own bucket.
        audio = Path(call("media/decode", {"path": str(self.song)})["result"]["path"])
        call("video/frames", {"path": str(self.clip), "count": 1})

        self.assertTrue(audio.is_file())
        self.assertEqual(len(list((self.cache / "jobs" / "audio").iterdir())), 1)
        self.assertEqual(len(list((self.cache / "jobs" / "frames").iterdir())), 1)

    def test_frames_method_rejects_a_count_over_the_cap(self):
        response = call(
            "video/frames", {"path": str(self.clip), "count": video.MAX_FRAMES + 1}
        )

        self.assertEqual(response["error"]["code"], "protocol/invalid-request")

    def test_frames_method_rejects_a_non_positive_step(self):
        response = call("video/frames", {"path": str(self.clip), "step": 0})

        self.assertEqual(response["error"]["code"], "protocol/invalid-request")

    def test_frames_method_rejects_a_width_outside_the_range(self):
        response = call("video/frames", {"path": str(self.clip), "width": 8})

        self.assertEqual(response["error"]["code"], "protocol/invalid-request")

    def test_frames_method_rejects_a_time_that_is_not_finite(self):
        # JSON has literals for NaN and Infinity, and `json.loads` accepts them.
        # Every bound check is false against them, so without a check of its own
        # the request would succeed and come back with no stills and no reason.
        for name, value in (
            ("start", float("nan")),
            ("start", float("inf")),
            ("step", float("inf")),
        ):
            with self.subTest(name=name, value=value):
                response = call("video/frames", {"path": str(self.clip), name: value})

                self.assertEqual(response["error"]["code"], "protocol/invalid-request")
                self.assertIn("finite", response["error"]["message"])


if __name__ == "__main__":
    unittest.main()
