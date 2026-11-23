"""PNG encoding tests.

Run with: python -m unittest discover -s plugins/felyrics.media/backend/tests -v
"""

import unittest

import numpy as np

from felyrics_host.errors import ServiceError
from felyrics_media.image import encode_png

MAGIC = b"\x89PNG\r\n\x1a\n"


def size_of(png):
    """Width and height from the IHDR chunk, which always starts at byte 16."""

    return int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")


class EncodePngTest(unittest.TestCase):
    def test_encodes_a_png_with_the_requested_size(self):
        pixels = np.zeros((4, 5, 3), dtype=np.uint8)

        png = encode_png(pixels, width=5, height=4)

        self.assertTrue(png.startswith(MAGIC))
        self.assertEqual(size_of(png), (5, 4))
        self.assertGreater(len(png), 50)

    def test_rejects_pixels_that_do_not_match_the_size(self):
        pixels = np.zeros((4, 5, 4), dtype=np.uint8)

        with self.assertRaises(ServiceError) as caught:
            encode_png(pixels, width=5, height=4)

        self.assertEqual(caught.exception.code, "felyrics.media/unsupported-format")

    def test_rejects_a_dtype_that_is_not_uint8(self):
        pixels = np.zeros((4, 5, 3), dtype=np.float32)

        with self.assertRaises(ServiceError) as caught:
            encode_png(pixels, width=5, height=4)

        self.assertEqual(caught.exception.code, "felyrics.media/unsupported-format")


if __name__ == "__main__":
    unittest.main()
