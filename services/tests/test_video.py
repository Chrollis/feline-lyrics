"""Tests for the video decoder and the two protocol methods on top of it.

Run with: python -m unittest discover -s services/tests -v
"""

import json
import tempfile
import unittest
from pathlib import Path

from felyrics import runtime
from felyrics.errors import ServiceError
from felyrics.media import methods, video  # noqa: F401  (import registers methods)
from felyrics.server import respond
from support import write_flac, write_video


def call(name, params=None, request_id=1):
    request = {"id": request_id, "method": name}

    if params is not None:
        request["params"] = params

    return respond(json.dumps(request))


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
        shots = video.frames(self.clip, start=0.0, step=0.1, count=2)

        self.assertEqual(len(shots), 2)
        self.assertEqual([shot.at for shot in shots], [0.0, 0.1])
        self.assertEqual(shots[0].pixels.shape, (48, 64, 3))
        self.assertEqual(shots[0].pixels.dtype.name, "uint8")

    def test_frames_scales_to_the_asked_width(self):
        shots = video.frames(self.clip, count=1, width=32)

        # 64x48 scaled to 32 wide is 24 high: the aspect ratio is kept, not the
        # height the caller happened to imagine.
        self.assertEqual(shots[0].pixels.shape, (24, 32, 3))

    def test_frames_stops_when_the_file_ends(self):
        shots = video.frames(self.clip, start=5.0, step=0.1, count=2)

        self.assertEqual(shots, [])

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


if __name__ == "__main__":
    unittest.main()
