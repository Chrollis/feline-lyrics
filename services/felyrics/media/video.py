"""Video decoding through libav.

`probe` answers what the container claims without decoding a frame; `frames`
decodes a batch of stills. A batch, not one call per still: a scrubber preview
wants tens of frames at once, and one request per frame would pay the protocol
round trip and a fresh container open for each.

Scaling runs through `VideoFrame.reformat`, which is libswscale: the same
resampler the encoder uses, and the only cheap way to turn a 1080p frame into a
320 px thumbnail -- numpy slicing would drop pixels instead of averaging them.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import av
import numpy as np

from ..errors import ServiceError
from . import container as containers

# A preview asks for a strip of thumbnails, not for a frame dump. The cap keeps
# one request from writing thousands of files into the cache.
MAX_FRAMES = 240


@dataclass(frozen=True)
class VideoInfo:
    """What the container claims about its first video stream."""

    width: int
    height: int
    fps: float
    duration: float
    codec: str


@dataclass(frozen=True)
class Frame:
    """One decoded still: `at` seconds into the file, shape (height, width, 3)."""

    at: float
    pixels: np.ndarray


def probe(path: str | Path) -> VideoInfo:
    """Reads the stream parameters without decoding."""

    with containers.open(path) as opened:
        stream = _video_stream(opened, path)
        context = stream.codec_context

        return VideoInfo(
            width=int(context.width or 0),
            height=int(context.height or 0),
            fps=_rate(stream),
            duration=containers.duration(opened),
            codec=context.name or "unknown",
        )


def frames(
    path: str | Path,
    *,
    start: float = 0.0,
    step: float = 0.5,
    count: int = 1,
    width: int | None = None,
) -> list[Frame]:
    """Decodes stills at `start + index * step` seconds, scaled to `width`.

    Returns fewer than `count` when the file ends first: a preview asks for a
    timeline nobody measured, and a short list is more useful than an error.
    """

    targets = [start + index * step for index in range(count)]

    with containers.open(path) as opened:
        stream = _video_stream(opened, path)
        _seek(opened, stream, start)

        found: list[Frame] = []
        pending = 0

        try:
            for frame in opened.decode(stream):
                at = _seconds(frame, stream)

                if at is None:
                    continue

                # One decoded frame can satisfy several targets: a 10 fps source
                # asked for 30 fps stills has nothing newer to offer.
                while pending < len(targets) and at >= targets[pending] - _EPSILON:
                    found.append(
                        Frame(at=targets[pending], pixels=_pixels(frame, width))
                    )
                    pending += 1

                if pending >= len(targets):
                    break
        except av.FFmpegError as error:
            raise ServiceError(
                "media/decode-failed", f"cannot decode {path}: {error}"
            ) from error

    return found


_EPSILON = 1e-6


def _seek(
    opened: av.container.InputContainer,
    stream: av.video.stream.VideoStream,
    start: float,
) -> None:
    """Jumps to the keyframe before `start`; a non-seekable input starts at 0.

    Seeking is an optimisation, not a requirement: without it the loop below
    simply decodes the frames it does not need and drops them.
    """

    if start <= 0:
        return

    try:
        opened.seek(int(start / float(stream.time_base)), stream=stream)
    except (av.FFmpegError, ValueError, ZeroDivisionError):
        return


def _seconds(frame: av.VideoFrame, stream: av.video.stream.VideoStream) -> float | None:
    if frame.pts is None:
        return None

    return float(frame.pts * stream.time_base)


def _pixels(frame: av.VideoFrame, width: int | None) -> np.ndarray:
    if width is not None and width != frame.width:
        height = max(2, round(frame.height * width / frame.width))
        # Encoders and some decoders want even dimensions; rounding down costs
        # one row and keeps the PNG free of a half-pixel row.
        height -= height % 2
        frame = frame.reformat(width=width, height=height, format="rgb24")

    return np.asarray(frame.to_ndarray(format="rgb24"), dtype=np.uint8)


def _rate(stream: av.video.stream.VideoStream) -> float:
    rate = stream.average_rate

    if not rate:
        return 0.0

    return float(rate)


def _video_stream(
    opened: av.container.InputContainer, path: str | Path
) -> av.video.stream.VideoStream:
    if not opened.streams.video:
        raise ServiceError("media/no-video-stream", f"{path} has no video stream")

    return opened.streams.video[0]
