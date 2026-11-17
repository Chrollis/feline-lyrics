"""PNG encoding through libav.

The renderer produces RGB frames in memory and needs a file on disk. libav's PNG
encoder is already installed, so this module does not pull in Pillow just for one
format, and the pixels never leave numpy until they are encoded.

This is the replacement for `encode_png` in the previous project's
`services/felyrics/video.py:24-39`; the name changed because a single still image
is not a video.
"""

from __future__ import annotations

import io

import av
import numpy as np

from ..errors import ServiceError


def encode_png(pixels: np.ndarray, *, width: int, height: int) -> bytes:
    """Encodes one RGB24 frame, shape (height, width, 3), as PNG bytes."""

    frame = _frame(pixels, width, height)
    buffer = io.BytesIO()

    try:
        with av.open(buffer, "w", format="image2pipe") as output:
            stream = output.add_stream("png")
            # Three attributes, all mandatory: the encoder is opened lazily when
            # the first frame is muxed, and it cannot guess the picture size or
            # the input pixel format. Missing any of them fails with
            # `avcodec_open2("png", {}) returned 22`.
            stream.width = width
            stream.height = height
            stream.pix_fmt = "rgb24"
            output.mux(stream.encode(frame))
            output.mux(stream.encode(None))
    except av.FFmpegError as error:
        raise ServiceError(
            "media/encode-failed",
            f"cannot encode a {width}x{height} PNG: {error}",
        ) from error

    return buffer.getvalue()


def _frame(pixels: np.ndarray, width: int, height: int) -> av.VideoFrame:
    if pixels.dtype != np.uint8:
        raise ServiceError(
            "media/unsupported-format", f"pixels must be uint8, not {pixels.dtype}"
        )

    expected = (height, width, 3)

    if pixels.shape != expected:
        raise ServiceError(
            "media/unsupported-format",
            f"pixels must have shape {expected}, not {pixels.shape}",
        )

    return av.VideoFrame.from_ndarray(np.ascontiguousarray(pixels), format="rgb24")
