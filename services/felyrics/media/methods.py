"""Protocol methods for the media layer.

`media/probe` answers "what is in this file"; `media/decode` answers "give me
those samples as a file I can play". Two methods rather than one `format`
parameter, because a result that is sometimes a path and sometimes bytes is a
union every client has to decode anyway -- and choosing the container is the
backend's job, not the caller's.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from .. import runtime
from ..errors import ServiceError
from ..server import method
from . import audio


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
    target = _job_dir() / "audio.flac"

    audio.save(decoded, target)

    return {
        "path": str(target),
        "sample_rate": decoded.sample_rate,
        "layout": decoded.layout,
        "channels": decoded.channels,
        "frames": decoded.frames,
        "duration": decoded.duration,
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


def _job_dir() -> Path:
    """One directory per call, so two decodes never overwrite each other."""

    directory = runtime.cache_root() / "jobs" / uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=True)

    return directory
