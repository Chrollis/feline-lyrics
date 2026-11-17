"""Fixtures shared by the service tests."""

from __future__ import annotations

import av
import numpy as np


def write_flac(path, *, rate, layout, frames, value=1000):
    """Writes `frames` samples of a constant, so a round trip can be compared."""

    channels = av.AudioLayout(layout).nb_channels
    # s16 is a packed format: one row, channels interleaved. The value is
    # constant, so interleaving is the same as repeating it.
    samples = np.full((1, frames * channels), value, dtype=np.int16)
    container = av.open(str(path), "w", format="flac")
    stream = container.add_stream("flac", rate=rate, layout=layout)
    frame = av.AudioFrame.from_ndarray(samples, format="s16", layout=layout)
    frame.sample_rate = rate
    container.mux(stream.encode(frame))
    container.mux(stream.encode(None))
    container.close()


def write_video(path, *, width=64, height=48, count=3, rate=10):
    """Writes `count` frames of MPEG-4 video, each a different shade of red.

    The colour changes per frame so an extracted still can be traced back to the
    frame it came from instead of comparing two identical pictures.
    """

    container = av.open(str(path), "w", format="mp4")
    stream = container.add_stream("mpeg4", rate=rate)
    stream.width = width
    stream.height = height
    stream.pix_fmt = "yuv420p"

    for index in range(count):
        pixels = np.zeros((height, width, 3), dtype=np.uint8)
        pixels[:, :, 0] = 40 + index * 60
        frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
        frame.pts = index
        container.mux(stream.encode(frame))

    container.mux(stream.encode(None))
    container.close()
