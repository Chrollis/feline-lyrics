"""Audio decoding through libav.

The decoder never picks a format on its own: every parameter defaults to the
source, because only the caller knows whether it wants 16 kHz mono for alignment
or 48 kHz stereo for playback. Resampling runs inside libswresample instead of
numpy -- it is faster, and it is correct about `skip_samples`, which hand-written
decimation gets wrong on AAC.

Output is planar float32, shape (channels, frames): float because downstream DSP
(a filtering, alignment scoring) works in float, planar because every channel is
then a contiguous slice.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import av
import numpy as np

from ..errors import ServiceError
from . import container as containers


@dataclass(frozen=True)
class AudioInfo:
    """What the container claims, read without decoding a single frame."""

    sample_rate: int
    layout: str
    channels: int
    duration: float
    codec: str


@dataclass(frozen=True)
class Audio:
    """Planar float32 samples, shape (channels, frames)."""

    samples: np.ndarray
    sample_rate: int
    layout: str

    @property
    def channels(self) -> int:
        return int(self.samples.shape[0])

    @property
    def frames(self) -> int:
        return int(self.samples.shape[1])

    @property
    def duration(self) -> float:
        return self.frames / self.sample_rate if self.sample_rate else 0.0


def probe(path: str | Path) -> AudioInfo:
    """Reads the stream parameters without decoding."""

    with containers.open(path) as opened:
        stream = _audio_stream(opened, path)
        context = stream.codec_context
        layout = context.layout

        return AudioInfo(
            sample_rate=int(context.sample_rate or 0),
            layout=layout.name if layout else "unknown",
            channels=layout.nb_channels if layout else 0,
            duration=containers.duration(opened),
            codec=context.name or "unknown",
        )


def decode(
    path: str | Path,
    *,
    rate: int | None = None,
    layout: str | None = None,
) -> Audio:
    """Decodes the first audio stream, optionally to `rate` and `layout`.

    `None` means "keep what the file has", including its rate and its channel
    count; it does not mean "use my idea of a default".
    """

    with containers.open(path) as opened:
        stream = _audio_stream(opened, path)
        context = stream.codec_context
        target_rate = rate or int(context.sample_rate or 0)
        target_layout = layout or _layout_name(context, path)

        if not target_rate:
            raise ServiceError("media/unknown-rate", f"{path} declares no sample rate")

        try:
            resampler = av.AudioResampler(
                format="fltp",
                layout=target_layout,
                rate=target_rate,
            )
        except (ValueError, av.FFmpegError) as error:
            raise ServiceError(
                "media/unsupported-format",
                f"cannot convert {path} to {target_rate} Hz {target_layout}: {error}",
            ) from error

        chunks: list[np.ndarray] = []

        try:
            for frame in opened.decode(stream):
                for converted in resampler.resample(frame):
                    chunks.append(_plane(converted))
            for converted in resampler.resample(None):
                chunks.append(_plane(converted))
        except av.FFmpegError as error:
            raise ServiceError(
                "media/decode-failed", f"cannot decode {path}: {error}"
            ) from error

    if chunks:
        samples = np.concatenate(chunks, axis=1)
    else:
        samples = np.zeros((_channels(target_layout, path), 0), dtype=np.float32)

    return Audio(samples=samples, sample_rate=target_rate, layout=target_layout)


def save(audio: Audio, path: str | Path) -> None:
    """Writes the samples as FLAC, which is lossless and that Chromium plays.

    The samples are float32 in [-1, 1]; FLAC wants integers, so the conversion
    clips first. Clipping at this point is not lossy for anything the decoder
    produced -- a float sample outside that range cannot be represented in the
    source format either -- and it keeps a resampled overshoot from wrapping
    around into the opposite sign.
    """

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)

    try:
        with av.open(str(target), "w", format="flac") as output:
            stream = output.add_stream(
                "flac", rate=audio.sample_rate, layout=audio.layout
            )
            output.mux(stream.encode(_packed(audio)))
            output.mux(stream.encode(None))
    except av.FFmpegError as error:
        raise ServiceError(
            "media/encode-failed", f"cannot write {target}: {error}"
        ) from error


def _packed(audio: Audio) -> av.AudioFrame:
    """One frame in FLAC's packed s16 layout: shape (1, frames * channels)."""

    clipped = np.clip(audio.samples, -1.0, 1.0)
    interleaved = np.round(clipped * 32767.0).astype(np.int16).T
    samples = np.ascontiguousarray(interleaved).reshape(1, -1)
    frame = av.AudioFrame.from_ndarray(samples, format="s16", layout=audio.layout)
    frame.sample_rate = audio.sample_rate

    return frame


def _plane(frame: av.AudioFrame) -> np.ndarray:
    """One resampled frame as (channels, frames) float32.

    `to_ndarray` returns an array that owns its buffer, so concatenating frames
    after the decoder has moved on is safe.
    """

    return np.asarray(frame.to_ndarray(), dtype=np.float32)


def _channels(layout: str, path: str | Path) -> int:
    try:
        return av.AudioLayout(layout).nb_channels
    except ValueError as error:
        raise ServiceError(
            "media/unknown-layout", f"{path} cannot be expressed as {layout!r}"
        ) from error


def _audio_stream(
    container: av.container.InputContainer, path: str | Path
) -> av.audio.stream.AudioStream:
    if not container.streams.audio:
        raise ServiceError("media/no-audio-stream", f"{path} has no audio stream")

    return container.streams.audio[0]


def _layout_name(
    context: av.AudioCodecContext, path: str | Path
) -> str:
    if context.layout is None:
        raise ServiceError("media/unknown-layout", f"{path} declares no channel layout")

    return context.layout.name
