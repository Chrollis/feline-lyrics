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
