"""Opening a media container, and reading how long it claims to be.

Every decoder in this layer starts the same way: turn a path into an
`InputContainer`, or fail with the one code the client branches on. Same for the
duration, which libav reports in `av.time_base` units and which every caller
wants in seconds. Both live here so audio and video cannot drift apart.
"""

from __future__ import annotations

from pathlib import Path

import av

from ..errors import ServiceError


def open(path: str | Path) -> av.container.InputContainer:
    """Opens a container for reading, or raises `media/open-failed`."""

    try:
        return av.open(str(path))
    except (OSError, av.FFmpegError) as error:
        raise ServiceError("media/open-failed", f"cannot open {path}: {error}") from error


def duration(opened: av.container.InputContainer) -> float:
    """The container's duration in seconds, or 0.0 when it does not say."""

    if opened.duration is None:
        return 0.0

    return float(opened.duration) / av.time_base
