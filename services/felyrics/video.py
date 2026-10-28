"""Video frame extraction for ``request_range kind="video"``.

One :class:`VideoFile` per open source. ``read_window`` seeks once, decodes the
frames of the window, and renders exactly one PNG per output slot, where slot
``k`` is ``start_sec + k / fps`` and the chosen source frame is the last one
with ``pts <= t_k`` (hold-last, see ``docs/.be/api.md`` section 7).
"""

from __future__ import annotations

import io
import math
import threading
from typing import Any

import av

from .sources import SourceError

FALLBACK_FPS = 30.0
MIN_WIDTH = 16


def _pts_sec(frame: av.VideoFrame) -> float:
    if frame.pts is None or frame.time_base is None:
        return 0.0
    return float(frame.pts * frame.time_base)


def encode_png(frame: av.VideoFrame, width: int, height: int) -> bytes:
    """Encode one decoded frame as a PNG of exactly ``width`` x ``height``."""
    rgb = frame.reformat(width=width, height=height, format="rgb24")
    rgb.pts = 0

    buffer = io.BytesIO()
    container = av.open(buffer, "w", format="image2pipe")
    stream = container.add_stream("png")
    stream.width = width
    stream.height = height
    stream.pix_fmt = "rgb24"
    for packet in stream.encode(rgb):
        container.mux(packet)
    container.mux(stream.encode(None))
    container.close()
    return buffer.getvalue()


class VideoFile:
    """An open video stream; PNG rendering happens per request."""

    def __init__(
        self,
        path: str,
        container: av.container.InputContainer,
        stream: av.VideoStream,
        duration_sec: float,
    ) -> None:
        self.path = path
        self.duration_sec = duration_sec
        self.width = int(stream.width or 0)
        self.height = int(stream.height or 0)
        self.codec = stream.codec_context.name
        rate = stream.average_rate or stream.guessed_rate
        self.fps = float(rate) if rate else FALLBACK_FPS
        self._container = container
        self._stream = stream
        self._lock = threading.Lock()
        self._closed = False

    @classmethod
    def open(cls, path: str) -> "VideoFile | None":
        """Open ``path`` and pick its first video stream; ``None`` when absent."""
        try:
            container = av.open(path)
        except Exception as exc:  # noqa: BLE001 - surfaced to the frontend as data
            raise SourceError(
                "source-open-failed",
                str(exc),
                path=path,
                reason=type(exc).__name__,
            ) from exc
        streams = [s for s in container.streams if s.type == "video"]
        if not streams:
            container.close()
            return None
        stream = streams[0]
        if stream.time_base is None:
            container.close()
            raise SourceError(
                "source-unsupported-media", "video stream has no time base", path=path
            )
        duration = 0.0
        if stream.duration is not None:
            duration = float(stream.duration * stream.time_base)
        if duration <= 0.0 and container.duration is not None:
            duration = float(container.duration) / 1_000_000
        if duration <= 0.0:
            container.close()
            raise SourceError(
                "source-unsupported-media", "video duration is unknown", path=path
            )
        return cls(path, container, stream, duration)

    def view(self) -> dict[str, Any]:
        return {
            "codec": self.codec,
            "width": self.width,
            "height": self.height,
            "fps": round(self.fps, 3),
        }

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._container.close()

    def read_window(
        self,
        start_sec: float,
        duration_sec: float,
        fps: int,
        scale: float,
        max_payload_bytes: int,
    ) -> list[dict[str, Any]]:
        """Return one entry per output slot, oldest first.

        Each entry holds the frame header fields plus ``png`` (the payload).
        The list is shorter than the slot count only at end of file.
        """
        if start_sec < 0.0:
            raise SourceError(
                "range-out-of-bounds", "start_sec must not be negative", start_sec=start_sec
            )
        count = max(1, int(math.ceil(duration_sec * fps - 1e-9)))
        width = self.width
        if width > 0:
            width = max(MIN_WIDTH, int(round(self.width * scale)))
            width = min(width, self.width)

        with self._lock:
            if self._closed:
                raise SourceError("source-closed", "source is closed", path=self.path)
            try:
                # seek offsets for a stream are in that stream's time base.
                ticks = int(round(start_sec / float(self._stream.time_base)))
                self._container.seek(ticks, stream=self._stream, backward=True)
            except Exception as exc:  # noqa: BLE001 - seek failures are protocol data
                raise SourceError(
                    "source-seek-failed",
                    f"seek to {start_sec:.3f} s failed: {exc}",
                    start_sec=start_sec,
                ) from exc
            frames = self._container.decode(self._stream)
            current: av.VideoFrame | None = None
            pending = next(frames, None)
            out: list[dict[str, Any]] = []
            for slot in range(count):
                target = start_sec + slot / fps
                while pending is not None and _pts_sec(pending) <= target + 1e-6:
                    current = pending
                    pending = next(frames, None)
                chosen = current if current is not None else pending
                if chosen is None:
                    break
                out.append(self._render(chosen, width, max_payload_bytes))
            return out

    def _render(
        self, frame: av.VideoFrame, width: int, max_payload_bytes: int
    ) -> dict[str, Any]:
        src_w = frame.width or self.width or width
        src_h = frame.height or self.height or width
        height = max(2, int(round(width * src_h / src_w)))
        payload = b""
        while True:
            payload = encode_png(frame, width, height)
            if len(payload) <= max_payload_bytes or width <= MIN_WIDTH:
                break
            width = max(MIN_WIDTH, width // 2)
            height = max(2, int(round(width * src_h / src_w)))
        pts = _pts_sec(frame)
        return {
            "pts_us": int(round(pts * 1_000_000)),
            "frame_index": int(round(pts * self.fps)),
            "width": width,
            "height": height,
            "png": payload,
        }
