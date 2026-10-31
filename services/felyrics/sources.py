"""Open an audio file once and hand out PCM ranges from it.

Everything this module returns has one fixed shape: 48 kHz, stereo, float32,
planar (a ``(2, n)`` numpy array). All PyAV work is confined here, so the rest
of the service never touches codecs or containers.

Three rules make a mid-stream read identical to the same slice of a full
sequential decode. They were established by ``cache/temp/decode-spike.py``
before this module existed, so they are measurements, not guesses:

1. Seek a little before the target and throw the warm-up away. mp3 needs
   earlier frames (bit reservoir) and a fresh resampler needs its filter
   history. 0.25 s of preroll makes the reads bit-exact on the test media.
2. The decoded buffer starts *earlier* than the first frame's pts, because
   ffmpeg only applies the stream's initial ``skip_samples`` at the very
   beginning of the stream. So
   ``buffer_start = first_frame_pts - stream.start_time``.
   Without this an mp3 read is 1105 samples (23 ms) off.
3. Drop ``round((target - buffer_start) * rate)`` decoded samples, then keep
   exactly what was asked for.

A read that continues forward from the cursor needs none of that: it keeps
decoding, which is cheaper and exact by construction. On AAC, which ffmpeg
does not decode identically from a mid-stream seek, this is also what keeps
sequential playback exact; only jumps pay the approximation.
"""

from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any

import av
import numpy as np

OUTPUT_RATE = 48000
OUTPUT_LAYOUT = "stereo"
OUTPUT_FORMAT = "fltp"
CHANNELS = 2

# How much audio to decode and discard before a seek target. Covers mp3 bit
# reservoir (about two frames) and resampler filter warm-up, with margin.
PREROLL_SEC = 0.25

# Reading further ahead than this re-seeks instead of decoding through the gap.
MAX_CONTINUE_SEC = 1.0
MAX_CONTINUE_SAMPLES = int(MAX_CONTINUE_SEC * OUTPUT_RATE)

MAX_OPEN_SOURCES = 8


def _new_resampler() -> av.AudioResampler:
    return av.AudioResampler(format=OUTPUT_FORMAT, layout=OUTPUT_LAYOUT, rate=OUTPUT_RATE)


def _empty() -> np.ndarray:
    return np.zeros((CHANNELS, 0), dtype=np.float32)


class SourceError(Exception):
    """A failure the frontend is meant to understand.

    ``code`` is kebab-case to match the ``packages/*/src/main/errors.ts``
    vocabulary; ``data`` becomes the error payload on the wire.
    """

    def __init__(self, code: str, message: str, **data: Any) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


class _Reader:
    """Decode cursor over one container.

    Not thread safe on its own: the owning ``Source`` holds the lock.
    """

    def __init__(self, container: av.container.InputContainer, stream: av.AudioStream) -> None:
        self._container = container
        self._stream = stream
        self._time_base = float(stream.time_base)
        self._start_time_sec = (
            float(stream.start_time * self._time_base)
            if stream.start_time is not None
            else 0.0
        )
        self._frames = container.decode(stream)
        self._resampler = _new_resampler()
        self._pending: list[np.ndarray] = []
        self._pending_start: int | None = None
        self._pending_len = 0
        self._eof = False

    # -- pending buffer ----------------------------------------------------

    def _pending_end(self) -> int:
        if self._pending_start is None:
            return -1
        return self._pending_start + self._pending_len

    def _reset(self) -> None:
        self._pending = []
        self._pending_start = None
        self._pending_len = 0
        self._resampler = _new_resampler()
        self._eof = False

    def _store(self, arrays: list[np.ndarray]) -> None:
        if not arrays:
            return
        self._pending.extend(arrays)
        self._pending_len += sum(a.shape[1] for a in arrays)

    def _pull(self) -> bool:
        """Move one input frame into the pending buffer. False at end of file."""
        try:
            frame = next(self._frames)
        except StopIteration:
            return False
        if self._pending_start is None:
            pts_sec = (
                float(frame.pts) * self._time_base if frame.pts is not None else self._start_time_sec
            )
            # Rule 2: the buffer starts before the frame's presentation time.
            self._pending_start = int(round((pts_sec - self._start_time_sec) * OUTPUT_RATE))
        self._store([out.to_ndarray() for out in self._resampler.resample(frame)])
        return True

    def _drain(self) -> None:
        """Flush the resampler's own delay. It holds a few samples at end of file."""
        if not self._eof:
            self._eof = True
            self._store([out.to_ndarray() for out in self._resampler.resample(None)])

    def _fill_until(self, target: int) -> None:
        while self._pending_end() < target:
            if self._eof or not self._pull():
                self._drain()
                return

    def _take(self, start: int, count: int) -> np.ndarray:
        if not self._pending or self._pending_start is None:
            return _empty()
        data = (
            np.concatenate(self._pending, axis=1)
            if len(self._pending) > 1
            else self._pending[0]
        )
        offset = max(start - self._pending_start, 0)
        stop = min(offset + count, data.shape[1])
        out = np.ascontiguousarray(data[:, offset:stop])
        if stop < data.shape[1]:
            self._pending = [data[:, stop:]]
            self._pending_len = data.shape[1] - stop
        else:
            self._pending = []
            self._pending_len = 0
        self._pending_start = self._pending_start + stop
        return out

    # -- repositioning -----------------------------------------------------

    def _reposition(self, start: int) -> None:
        target_sec = start / OUTPUT_RATE
        preroll = PREROLL_SEC
        for _ in range(3):
            seek_sec = max(target_sec - preroll, 0.0)
            if seek_sec > 0.0:
                self._container.seek(
                    int(seek_sec / self._time_base), stream=self._stream, backward=True
                )
            else:
                self._container.seek(0)
            self._frames = self._container.decode(self._stream)
            self._reset()
            if not self._pull():
                raise SourceError(
                    "source-decode-failed",
                    "no audio frames after seeking",
                    start_sample=start,
                )
            if self._pending_start is not None and self._pending_start <= start:
                return
            # The seek landed too late to cover the target; try further back.
            preroll *= 4.0
        raise SourceError(
            "source-seek-failed",
            "seek could not reach the requested sample",
            start_sample=start,
        )

    # -- public ------------------------------------------------------------

    def read(self, start: int, count: int) -> np.ndarray:
        if count <= 0:
            return _empty()
        can_continue = (
            self._pending_start is not None
            and start >= self._pending_start
            and start - self._pending_start <= MAX_CONTINUE_SAMPLES
        )
        if not can_continue:
            self._reposition(start)
        self._fill_until(start + count)
        return self._take(start, count)


class Source:
    """One open media file: metadata plus a decode cursor."""

    def __init__(
        self,
        path: Path,
        container: av.container.InputContainer,
        stream: av.AudioStream,
        duration_sec: float,
    ) -> None:
        self.id = uuid.uuid4().hex
        self.path = path
        self.duration_sec = duration_sec
        self.sample_rate = int(stream.rate or 0)
        self.channels = int(stream.channels or 0)
        self.codec = stream.codec_context.name
        self._container = container
        self._reader = _Reader(container, stream)
        self._lock = threading.Lock()
        self._closed = False

    @classmethod
    def open(cls, path: Path) -> "Source":
        path = Path(path)
        if not path.is_file():
            raise SourceError(
                "source-not-found", f"file does not exist: {path}", path=str(path)
            )
        try:
            container = av.open(str(path))
        except Exception as exc:  # noqa: BLE001 - surfaced to the frontend as data
            raise SourceError(
                "source-open-failed",
                str(exc),
                path=str(path),
                reason=type(exc).__name__,
            ) from exc
        streams = [s for s in container.streams if s.type == "audio"]
        if not streams:
            container.close()
            raise SourceError(
                "source-unsupported-media", "file has no audio stream", path=str(path)
            )
        stream = streams[0]
        if stream.time_base is None:
            container.close()
            raise SourceError(
                "source-unsupported-media", "audio stream has no time base", path=str(path)
            )
        duration = _duration_sec(container, stream)
        if duration is None or duration <= 0.0:
            container.close()
            raise SourceError(
                "source-unsupported-media", "audio duration is unknown", path=str(path)
            )
        return cls(path, container, stream, duration)

    @property
    def total_samples(self) -> int:
        return int(round(self.duration_sec * OUTPUT_RATE))

    def read(self, start_sample: int, count: int) -> np.ndarray:
        """Samples [start_sample, start_sample + count) in the output format.

        Shorter than ``count`` only at end of file.
        """
        if start_sample < 0:
            raise SourceError(
                "range-out-of-bounds",
                "start_sample must not be negative",
                start_sample=start_sample,
            )
        with self._lock:
            if self._closed:
                raise SourceError("source-closed", "source is closed", source_id=self.id)
            return self._reader.read(start_sample, count)

    def info(self) -> dict[str, Any]:
        return {
            "source_id": self.id,
            "path": str(self.path),
            "duration_sec": self.duration_sec,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "codec": self.codec,
            "total_samples": self.total_samples,
            "output_rate": OUTPUT_RATE,
            "output_channels": CHANNELS,
            "output_format": "f32-planar",
        }

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._container.close()


def _duration_sec(
    container: av.container.InputContainer, stream: av.AudioStream
) -> float | None:
    if stream.duration is not None and stream.time_base is not None:
        return float(stream.duration * stream.time_base)
    if container.duration is not None:
        return float(container.duration / av.time_base)
    return None


__all__ = [
    "CHANNELS",
    "MAX_OPEN_SOURCES",
    "OUTPUT_RATE",
    "Source",
    "SourceError",
]
