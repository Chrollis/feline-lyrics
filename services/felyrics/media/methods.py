"""Protocol methods for the media layer.

`media/probe` answers "what is in this file"; `media/decode` answers "give me
those samples as a file I can play". Two methods rather than one `format`
parameter, because a result that is sometimes a path and sometimes bytes is a
union every client has to decode anyway -- and choosing the container is the
backend's job, not the caller's.
"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any

from .. import runtime
from ..errors import ServiceError
from ..server import method
from . import audio, image, video

# The smallest thumbnail that is still readable, and the largest still worth
# encoding one file at a time.
MIN_FRAME_WIDTH = 16
MAX_FRAME_WIDTH = 4096


@method("media/probe")
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


@method("media/decode")
def decode(params: dict[str, Any]) -> dict[str, Any]:
    """Decodes to the asked-for rate and layout, then writes a FLAC file."""

    decoded = audio.decode(
        _source(params),
        rate=_optional_positive_int(params, "rate"),
        layout=_optional_text(params, "layout"),
    )
    directory = _new_job_dir("audio")
    target = directory / "audio.flac"

    try:
        audio.save(decoded, target)
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        raise

    _keep_only("audio", directory)
    return {
        "path": str(target),
        "sample_rate": decoded.sample_rate,
        "layout": decoded.layout,
        "channels": decoded.channels,
        "frames": decoded.frames,
        "duration": decoded.duration,
    }


@method("video/probe")
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


@method("video/frames")
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
        raise ServiceError("protocol/invalid-request", "'start' must not be negative")

    if step <= 0:
        raise ServiceError("protocol/invalid-request", "'step' must be positive")

    if count > video.MAX_FRAMES:
        raise ServiceError(
            "protocol/invalid-request",
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
                directory = _new_job_dir("frames")

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
                    "path": str(target),
                }
            )
    except BaseException:
        if directory is not None:
            shutil.rmtree(directory, ignore_errors=True)
        raise

    if directory is not None:
        _keep_only("frames", directory)

    return {
        "dir": str(directory) if directory is not None else "",
        "width": image_width,
        "height": image_height,
        "fps": info.fps,
        "frames": written,
    }


def _source(params: dict[str, Any]) -> Path:
    value = params.get("path")

    if not isinstance(value, str) or not value:
        raise ServiceError(
            "protocol/invalid-request", "media methods need a 'path' string"
        )

    return Path(value)


def _optional_positive_int(params: dict[str, Any], name: str) -> int | None:
    value = params.get(name)

    if value is None:
        return None

    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ServiceError(
            "protocol/invalid-request", f"'{name}' must be a positive integer"
        )

    return value


def _optional_text(params: dict[str, Any], name: str) -> str | None:
    value = params.get(name)

    if value is None:
        return None

    if not isinstance(value, str) or not value:
        raise ServiceError(
            "protocol/invalid-request", f"'{name}' must be a non-empty string"
        )

    return value


def _optional_number(params: dict[str, Any], name: str, default: float) -> float:
    value = params.get(name)

    if value is None:
        return default

    # bool is an int in Python, and `True` seconds is never what anyone meant.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ServiceError("protocol/invalid-request", f"'{name}' must be a number")

    return float(value)


def _frame_width(params: dict[str, Any]) -> int | None:
    width = _optional_positive_int(params, "width")

    if width is None:
        return None

    if not MIN_FRAME_WIDTH <= width <= MAX_FRAME_WIDTH:
        raise ServiceError(
            "protocol/invalid-request",
            f"'width' must be between {MIN_FRAME_WIDTH} and {MAX_FRAME_WIDTH}",
        )

    return width


def _new_job_dir(kind: str) -> Path:
    """Creates an empty directory per call, without touching the last one.

    A job directory only has to live until the next call of the same kind: the
    app works on one song at a time, and a result path is handed to the renderer
    immediately. The cache is user data, not the system temp directory, so
    nothing else would ever delete this -- one decode leaves one full copy of the
    audio behind, one frame request leaves one batch of stills.

    The bucket is per kind because the consumers overlap: the renderer can still
    be playing the decoded audio while the timeline asks for thumbnails, and a
    shared bucket would delete the file under the player.

    `kind` is also half of the media URL the desktop app builds
    (`app://media/<kind>/<job>/<file>`), and the other half is a whitelist in
    `apps/desktop/src/main/app-assets.ts` (`JOB_KINDS`). A new bucket here is a
    URL that 404s until that whitelist learns the name -- no error, just a
    picture that never appears.

    The old directory is dropped by `_keep_only` only once the new result is
    complete, so a request that fails or returns nothing leaves the previous
    one usable instead of destroying it first.
    """

    directory = runtime.cache_root() / "jobs" / kind / uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=True)

    return directory


def _keep_only(kind: str, keep: Path) -> None:
    """Drops every earlier job directory of this kind, once `keep` is complete.

    Cleanup is best effort on purpose: on Windows the previous file can still be
    open in the renderer, and losing a leak is cheaper than failing a request.
    """

    for old in (runtime.cache_root() / "jobs" / kind).iterdir():
        if old != keep:
            shutil.rmtree(old, ignore_errors=True)
