"""Audio decoding tests. Standard library plus av and numpy.

Run with: python -m unittest discover -s services/tests -v
"""

import tempfile
import unittest
from pathlib import Path

import numpy as np

from felyrics.errors import ServiceError
from felyrics.media.audio import decode, probe
from support import write_flac


class AudioTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name)

    def test_probe_reads_the_stream_without_decoding(self):
        source = self.dir / "music.flac"
        write_flac(source, rate=16000, layout="mono", frames=1600)

        info = probe(source)

        self.assertEqual(info.sample_rate, 16000)
        self.assertEqual(info.layout, "mono")
        self.assertEqual(info.channels, 1)
        self.assertEqual(info.codec, "flac")
        self.assertAlmostEqual(info.duration, 0.1, delta=0.02)

    def test_decode_keeps_the_source_rate_and_layout(self):
        source = self.dir / "music.flac"
        write_flac(source, rate=16000, layout="mono", frames=1600)

        audio = decode(source)

        self.assertEqual(audio.sample_rate, 16000)
        self.assertEqual(audio.layout, "mono")
        self.assertEqual(audio.channels, 1)
        self.assertEqual(audio.frames, 1600)
        self.assertAlmostEqual(audio.duration, 0.1, delta=0.001)
        np.testing.assert_allclose(audio.samples, 1000 / 32768, atol=1e-6)

    def test_decode_resamples_to_the_requested_rate(self):
        source = self.dir / "music.flac"
        write_flac(source, rate=44100, layout="mono", frames=4410)

        audio = decode(source, rate=16000)

        self.assertEqual(audio.sample_rate, 16000)
        self.assertAlmostEqual(audio.frames, 1600, delta=2)
        self.assertAlmostEqual(audio.duration, 0.1, delta=0.001)

    def test_decode_converts_the_layout(self):
        source = self.dir / "music.flac"
        write_flac(source, rate=16000, layout="stereo", frames=1600)

        audio = decode(source, layout="mono")

        self.assertEqual(audio.layout, "mono")
        self.assertEqual(audio.channels, 1)
        self.assertEqual(audio.frames, 1600)

    def test_a_missing_file_is_a_media_error(self):
        with self.assertRaises(ServiceError) as caught:
            decode(self.dir / "nope.flac")

        self.assertEqual(caught.exception.code, "felyrics.media/open-failed")

    def test_a_file_that_is_not_media_is_a_media_error(self):
        source = self.dir / "notes.txt"
        source.write_text("this is not audio", encoding="utf-8")

        with self.assertRaises(ServiceError) as caught:
            probe(source)

        self.assertEqual(caught.exception.code, "felyrics.media/open-failed")

    def test_an_unknown_layout_is_refused(self):
        source = self.dir / "music.flac"
        write_flac(source, rate=16000, layout="mono", frames=1600)

        with self.assertRaises(ServiceError) as caught:
            decode(source, layout="no-such-layout")

        self.assertEqual(caught.exception.code, "felyrics.media/unsupported-format")


if __name__ == "__main__":
    unittest.main()
