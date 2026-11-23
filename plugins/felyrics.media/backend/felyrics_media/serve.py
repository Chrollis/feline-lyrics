"""Protocol methods for the media plugin.

`probe` answers "what is in this file"; `decode` answers "give me those samples
as a file I can play". Two methods rather than one `format` parameter, because a
result that is sometimes a URL and sometimes bytes is a union every client has
to decode anyway -- and choosing the container is the backend's job, not the
caller's.

The host calls `serve(ctx)` once; the four handlers are registered under their
internal names. Nothing here imports a protocol loop: the host owns stdin,
stdout and error shaping.
"""

from __future__ import annotations

import math
import shutil
from pathlib import Path
from typing import Any

from felyrics_host.ctx import KIND_FILE, BackendContext
from felyrics_host.errors import ServiceError

from . import audio, image, video

# The smallest thumbnail that is still readable, and the largest still worth
# encoding one file at a time.
MIN_FRAME_WIDTH = 16
MAX_FRAME_WIDTH = 4096

# One process serves one plugin, so `serve` fixes the context once. Module-level
# state is honest here: the alternative is threading `ctx` through every helper
# that never needs anything but `new_job`.
_context: BackendContext | None = None


def probe(params: dict[str, Any]) -> dict[str, Any]:
    """Reads the stream parameters without decoding a single frame."""

    info = audio.probe(_source(params))

    return {
        "sample_rate": info.sample_rate,
        "layout": info.layout,
        "channels": info.channels,
        "duration": info.duration,
        "codec": info.codec,
    }


def decode(params: dict[str, Any]) -> dict[str, Any]:
    """Decodes to the asked-for rate and layout, then writes a FLAC file."""

    decoded = audio.decode(
        _source(params),
        rate=_optional_positive_int(params, "rate"),
        layout=_optional_text(params, "layout"),
    )
    directory = _new_job("audio")
    target = directory / "audio.flac"

    try:
        audio.save(decoded, target)
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        raise

    _keep_only(directory, "audio")
    return {
        "url": _context.jobUrl(directory, "audio.flac"),
        "sample_rate": decoded.sample_rate,
        "layout": decoded.layout,
        "channels": decoded.channels,
        "frames": decoded.frames,
        "duration": decoded.duration,
    }


def video_probe(params: dict[str, Any]) -> dict[str, Any]:
    """Reads the video stream parameters without decoding a frame."""

    info = video.probe(_source(params))

    return {
        "width": info.width,
        "height": info.height,
        "fps": info.fps,
        "duration": info.duration,
        "codec": info.codec,
    }


def video_frames(params: dict[str, Any]) -> dict[str, Any]:
    """Decodes stills and writes each one as a PNG before decoding the next.

    Writing inside the decode loop is what keeps memory flat: a 240-frame
    request at 1920 wide would otherwise hold a gigabyte of raw pixels.
    """

    source = _source(params)
    start = _optional_number(params, "start", 0.0)
    step = _optional_number(params, "step", 0.5)
    count = _optional_positive_int(params, "count") or 1
    width = _frame_width(params)

    if start < 0:
        raise ServiceError("felyrics.media/bad-request", "'start' must not be negative")

    if step <= 0:
        raise ServiceError("felyrics.media/bad-request", "'step' must be positive")

    if count > video.MAX_FRAMES:
        raise ServiceError(
            "felyrics.media/bad-request",
            f"'count' must not exceed {video.MAX_FRAMES}",
        )

    info = video.probe(source)

    # Created on the first frame, so an empty batch or a decode failure leaves
    # the stills the renderer is already showing untouched.
    directory: Path | None = None
    written = []
    image_width = 0
    image_height = 0

    try:
        for index, shot in enumerate(
            video.frames(source, start=start, step=step, count=count, width=width)
        ):
            if directory is None:
                directory = _new_job("frames")

            target = directory / f"{index + 1:04d}.png"
            image_height = int(shot.pixels.shape[0])
            image_width = int(shot.pixels.shape[1])
            target.write_bytes(
                image.encode_png(shot.pixels, width=image_width, height=image_height)
            )
            written.append(
                {
                    "index": index,
                    "requested": shot.requested,
                    "at": shot.at,
                    "url": _context.jobUrl(directory, target.name),
                }
            )
    except BaseException:
        if directory is not None:
            shutil.rmtree(directory, ignore_errors=True)
        raise

    if directory is not None:
        _keep_only(directory, "frames")

    return {
        "dir": _context.jobUrl(directory, "") if directory is not None else "",
        "width": image_width,
        "height": image_height,
        "fps": info.fps,
        "frames": written,
    }


def serve(ctx: BackendContext) -> None:
    """Registers the four internal handlers with the host."""

    global _context

    _context = ctx
    ctx.method("probe", probe)
    ctx.method("decode", decode)
    ctx.method("video-probe", video_probe)
    ctx.method("video-frames", video_frames)


def _source(params: dict[str, Any]) -> Path:
    value = params.get("path")

    if not isinstance(value, str) or not value:
        raise ServiceError(
            "felyrics.media/bad-request", "media methods need a 'path' string"
        )

    return Path(value)


def _optional_positive_int(params: dict[str, Any], name: str) -> int | None:
    value = params.get(name)

    if value is None:
        return None

    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ServiceError(
            "felyrics.media/bad-request", f"'{name}' must be a positive integer"
        )

    return value


def _optional_text(params: dict[str, Any], name: str) -> str | None:
    value = params.get(name)

    if value is None:
        return None

    if not isinstance(value, str) or not value:
        raise ServiceError(
            "felyrics.media/bad-request", f"'{name}' must be a non-empty string"
        )

    return value


def _optional_number(params: dict[str, Any], name: str, default: float) -> float:
    value = params.get(name)

    if value is None:
        return default

    # bool is an int in Python, and `True` seconds is never what anyone meant.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ServiceError(
            "felyrics.media/bad-request", f"'{name}' must be a number"
        )

    # `json` accepts NaN and Infinity as literals, and both make every comparison
    # below false: a batch would come back empty with no error to explain it.
    number = float(value)

    if not math.isfinite(number):
        raise ServiceError(
            "felyrics.media/bad-request", f"'{name}' must be finite"
        )

    return number


def _frame_width(params: dict[str, Any]) -> int | None:
    width = _optional_positive_int(params, "width")

    if width is None:
        return None

    if not MIN_FRAME_WIDTH <= width <= MAX_FRAME_WIDTH:
        raise ServiceError(
            "felyrics.media/bad-request",
            f"'width' must be between {MIN_FRAME_WIDTH} and {MAX_FRAME_WIDTH}",
        )

    return width


def _new_job(kind: str) -> Path:
    """Creates an empty job directory through the host's allocator.

    The host owns the layout (`<cache>/jobs/<job>` today); the plugin only names
    the kind. Cleanup happens in `_keep_only` once a result is complete.
    """

    if _context is None:
        raise RuntimeError("the media plugin was imported without serve()")

    return _context.new_job(kind)


def _keep_only(keep: Path, kind: str) -> None:
    """Drops every earlier job directory of this kind, once `keep` is complete.

    Job directories are flat, so the kind comes from the marker the host writes
    into each one; the audio and the stills jobs therefore cannot delete each
    other. Cleanup is best effort on purpose: on Windows the previous file can
    still be open in the renderer, and losing a leak is cheaper than failing a
    request.
    """

    for old in keep.parent.iterdir():
        if old == keep or not old.is_dir():
            continue

        try:
            previous = (old / KIND_FILE).read_text(encoding="utf-8")
        except OSError:
            continue

        if previous == kind:
            shutil.rmtree(old, ignore_errors=True)
