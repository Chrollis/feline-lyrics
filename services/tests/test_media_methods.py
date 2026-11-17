"""Tests for the media protocol methods, driven through the real `respond`.

Run with: python -m unittest discover -s services/tests -v
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from felyrics import runtime
from felyrics.media import methods  # noqa: F401  (import registers the methods)
from felyrics.media.audio import probe
from felyrics.server import respond
from support import write_flac


def call(name, params=None, request_id=1):
    request = {"id": request_id, "method": name}

    if params is not None:
        request["params"] = params

    return respond(json.dumps(request))


class MediaMethodsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name)
        self.cache = self.dir / "cache"
        runtime.configure(self.cache)
        self.source = self.dir / "music.flac"
        write_flac(self.source, rate=44100, layout="stereo", frames=4410)

    def test_probe_reports_the_source(self):
        response = call("media/probe", {"path": str(self.source)})

        result = response["result"]

        self.assertEqual(result["sample_rate"], 44100)
        self.assertEqual(result["layout"], "stereo")
        self.assertEqual(result["channels"], 2)
        self.assertEqual(result["codec"], "flac")
        self.assertAlmostEqual(result["duration"], 0.1, delta=0.02)

    def test_decode_writes_a_flac_under_the_cache(self):
        response = call(
            "media/decode",
            {"path": str(self.source), "rate": 16000, "layout": "mono"},
        )

        result = response["result"]
        target = Path(result["path"])

        self.assertTrue(target.is_file())
        self.assertEqual(target.read_bytes()[:4], b"fLaC")
        self.assertEqual(target.parent.parent, self.cache / "jobs")
        self.assertEqual(target.name, "audio.flac")
        self.assertEqual(result["sample_rate"], 16000)
        self.assertEqual(result["layout"], "mono")
        self.assertAlmostEqual(result["frames"], 1600, delta=2)

        # The written file must be readable by the same decoder that wrote it.
        written = probe(target)

        self.assertEqual(written.sample_rate, 16000)
        self.assertEqual(written.layout, "mono")

    def test_two_decodes_do_not_share_a_directory(self):
        first = Path(call("media/decode", {"path": str(self.source)})["result"]["path"])
        second = Path(
            call("media/decode", {"path": str(self.source)})["result"]["path"]
        )

        self.assertNotEqual(first.parent, second.parent)

    def test_a_decode_drops_the_previous_job_directory(self):
        first = Path(call("media/decode", {"path": str(self.source)})["result"]["path"])
        second = Path(
            call("media/decode", {"path": str(self.source)})["result"]["path"]
        )

        self.assertFalse(first.parent.exists())
        self.assertTrue(second.parent.is_dir())
        self.assertEqual(len(list((self.cache / "jobs").iterdir())), 1)

    def test_a_missing_path_parameter_is_a_protocol_error(self):
        response = call("media/probe", {})

        self.assertEqual(response["error"]["code"], "protocol/invalid-request")

    def test_a_missing_file_is_a_media_error(self):
        response = call("media/probe", {"path": str(self.dir / "nope.flac")})

        self.assertEqual(response["error"]["code"], "media/open-failed")

    def test_a_rate_that_is_not_a_number_is_a_protocol_error(self):
        response = call("media/decode", {"path": str(self.source), "rate": "fast"})

        self.assertEqual(response["error"]["code"], "protocol/invalid-request")


class EntryPointTest(unittest.TestCase):
    def test_the_cache_directory_is_required(self):
        completed = subprocess.run(
            [sys.executable, "-m", "felyrics"],
            input="",
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("--cache", completed.stderr)


if __name__ == "__main__":
    unittest.main()
