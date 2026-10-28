"""The WebSocket backend: envelope, binary frames and media requests.

The contract is docs/.be/api.md. This module owns the transport (JSON
envelope, binary frame container, token check) and the media handlers; audio
decoding and the per-source decode cursor live in sources.py.
"""

from __future__ import annotations

import asyncio
import hmac
import io
import json
import math
import os
import sys
import time
import traceback
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

import av
import numpy as np
from websockets.asyncio.server import Server, ServerConnection, serve as ws_serve

from . import annotate as annotator
from . import espeak, sources, tasks as taskboard
from .annotate import AnnotationError
from .video import VideoFile

PROTOCOL = 1
AUDIO_RATE = 48000
AUDIO_CHANNELS = 2
AUDIO_BITS = 24
MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
MAX_RANGE_SECONDS = 10
MAX_OPEN_SOURCES = 8
MEDIA_WORKERS = 4
VIDEO_SCALES = (1.0, 0.5, 0.3333, 0.25)
VIDEO_FPS = (24, 30, 60)
VIDEO_DEFAULT_SCALE = 0.5
VIDEO_DEFAULT_FPS = 30
VIDEO_STREAM_INDEX = 1
AUDIO_STREAM_INDEX = 0
IPA_LANGUAGES = ("en", "de", "fr", "ru", "es", "it", "pt")

_METHODS = (
    "hello",
    "open_source",
    "close_source",
    "request_range",
    "annotate",
    "task.submit",
    "task.cancel",
    "task.list",
    "task.get",
    "shutdown",
)


class BackendError(Exception):
    """A protocol-level failure carrying a code from api.md section 12."""

    def __init__(self, code: str, message: str, data: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data: dict[str, Any] = dict(data) if data else {}


class OpenedSource:
    """One registered media file: an audio source, a video stream, or both."""

    def __init__(
        self,
        path: str,
        audio: sources.Source | None,
        video: VideoFile | None,
    ) -> None:
        self.id = uuid.uuid4().hex
        self.path = path
        self.audio = audio
        self.video = video
        self.duration_sec = max(
            audio.duration_sec if audio is not None else 0.0,
            video.duration_sec if video is not None else 0.0,
        )

    def close(self) -> None:
        if self.audio is not None:
            self.audio.close()
        if self.video is not None:
            self.video.close()


def _encoder_available(name: str) -> bool:
    try:
        av.codec.Codec(name, "w")
    except Exception:  # noqa: BLE001 - the name is simply not in this build
        return False
    return True


def encode_flac(pcm: np.ndarray) -> bytes:
    """Encode (channels, samples) float32 planar as one 24-bit FLAC stream.

    The FLAC encoder only takes s16 or s32, so 24 bits are s32 samples with the
    low byte zero (api.md section 5): quantise, left-justify by 8, one frame.
    """
    if pcm.ndim != 2 or pcm.shape[0] != AUDIO_CHANNELS:
        raise ValueError(f"expected ({AUDIO_CHANNELS}, n) planar float32")
    interleaved = np.ascontiguousarray(pcm.T).reshape(-1)
    quantised = np.clip(
        np.round(interleaved.astype(np.float64) * 2**23), -(2**23), 2**23 - 1
    )
    packed = (quantised.astype(np.int64) * 256).astype(np.int32)

    buffer = io.BytesIO()
    container = av.open(buffer, "w", format="flac")
    stream = container.add_stream("flac", rate=AUDIO_RATE, layout="stereo")
    stream.format = "s32"
    frame = av.AudioFrame.from_ndarray(
        packed.reshape(1, -1), format="s32", layout="stereo"
    )
    frame.sample_rate = AUDIO_RATE
    container.mux(stream.encode(frame))
    container.mux(stream.encode(None))
    container.close()
    return buffer.getvalue()


def _header(header: dict[str, Any], payload: bytes) -> bytes:
    head = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return len(head).to_bytes(4, "little") + head + payload


class BackendService:
    """State shared by every connection: sources, executor, process stop."""

    def __init__(self, token: str, espeak_dir: str | None = None) -> None:
        if not token:
            raise ValueError("a token is required")
        self.token = token
        self.espeak_dir = espeak_dir
        espeak.configure(espeak_dir)
        self.stopped = asyncio.Event()
        self._media: OrderedDict[str, OpenedSource] = OrderedDict()
        self._executor = ThreadPoolExecutor(
            max_workers=MEDIA_WORKERS, thread_name_prefix="media"
        )
        self._encoders = {
            name for name in ("flac", "png") if _encoder_available(name)
        }
        self._server: Server | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._helloed: set[ServerConnection] = set()
        self._connections: set[ServerConnection] = set()
        self._closed = False
        self.tasks = taskboard.TaskBoard(self._emit_event)
        self._whisper = taskboard.WhisperStore()

    def attach(self, server: Server) -> None:
        self._server = server

    # -- logging -----------------------------------------------------------

    def log(self, event: str, **fields: Any) -> None:
        line = {"event": event, "ts": round(time.time(), 3), **fields}
        sys.stderr.write(json.dumps(line, ensure_ascii=False) + "\n")
        sys.stderr.flush()

    # -- task events -------------------------------------------------------

    def _emit_event(self, event: str, payload: dict[str, Any]) -> None:
        """Called from the task worker thread; hops back to the event loop."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._schedule_event, event, payload)

    def _schedule_event(self, event: str, payload: dict[str, Any]) -> None:
        asyncio.ensure_future(self._broadcast(event, payload))

    async def _broadcast(self, event: str, payload: dict[str, Any]) -> None:
        data = {key: value for key, value in payload.items() if key != "task_id"}
        message = json.dumps(
            {
                "v": PROTOCOL,
                "type": "event",
                "event": event,
                "task_id": payload.get("task_id"),
                "data": data,
            }
        )
        for connection in list(self._helloed):
            try:
                await connection.send(message)
            except Exception:  # noqa: BLE001 - the peer may be gone
                self._helloed.discard(connection)

    # -- connection --------------------------------------------------------

    def _authorized(self, connection: ServerConnection) -> bool:
        request = connection.request
        query = parse_qs(urlsplit(request.path).query)
        token = (query.get("token") or [""])[0]
        if not token:
            header = request.headers.get("Authorization", "")
            if header.lower().startswith("bearer "):
                token = header[7:].strip()
        return bool(token) and hmac.compare_digest(token, self.token)

    async def handler(self, connection: ServerConnection) -> None:
        if not self._authorized(connection):
            await connection.close(code=4401, reason="unauthorized")
            return
        self._connections.add(connection)
        try:
            async for raw in connection:
                if isinstance(raw, (bytes, bytearray)):
                    await self._send_error(
                        connection,
                        None,
                        "bad-request",
                        "binary frames are outbound only",
                    )
                    continue
                await self._handle_text(connection, raw)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            raise
        finally:
            self._helloed.discard(connection)
            self._connections.discard(connection)

    async def _handle_text(self, connection: ServerConnection, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            await self._send_error(connection, None, "bad-request", "malformed JSON")
            return
        if not isinstance(message, dict):
            await self._send_error(connection, None, "bad-request", "expected an object")
            return

        msg_id = message.get("id")
        if message.get("v") != PROTOCOL:
            await self._send_error(
                connection, msg_id, "protocol-mismatch", f"unsupported v {message.get('v')!r}"
            )
            return
        method = message.get("method")
        if not isinstance(method, str) or method not in _METHODS:
            await self._send_error(
                connection, msg_id, "bad-request", f"unknown method {method!r}"
            )
            return
        params = message.get("params") or {}
        if not isinstance(params, dict):
            await self._send_error(connection, msg_id, "bad-request", "params must be an object")
            return
        if method != "hello" and method != "shutdown" and connection not in self._helloed:
            await self._send_error(connection, msg_id, "hello-required", "send hello first")
            return

        handler: Callable[..., Any] | None = getattr(
            self, "_m_" + method.replace(".", "_"), None
        )
        if handler is None:
            await self._send_error(
                connection,
                msg_id,
                "bad-request",
                f"method {method!r} is not implemented in this build",
            )
            return
        try:
            result = await handler(connection, msg_id, params)
        except sources.SourceError as exc:
            await self._send_error(connection, msg_id, exc.code, str(exc), exc.data)
        except BackendError as exc:
            await self._send_error(connection, msg_id, exc.code, exc.message, exc.data)
        except AnnotationError as exc:
            await self._send_error(connection, msg_id, exc.code, exc.message, exc.data)
        except taskboard.TaskError as exc:
            await self._send_error(connection, msg_id, exc.code, exc.message, exc.data)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - last resort, logged with a traceback
            self.log("internal-error", method=method, detail=repr(exc))
            traceback.print_exc(file=sys.stderr)
            await self._send_error(
                connection, msg_id, "internal-error", "internal error", {"detail": repr(exc)}
            )
        else:
            if result is not None:
                await connection.send(
                    json.dumps({"v": PROTOCOL, "id": msg_id, "ok": True, "result": result})
                )

    async def _send_error(
        self,
        connection: ServerConnection,
        msg_id: Any,
        code: str,
        message: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data:
            error["data"] = data
        await connection.send(
            json.dumps({"v": PROTOCOL, "id": msg_id, "ok": False, "error": error})
        )

    # -- hello -------------------------------------------------------------

    def _ipa_info(self) -> dict[str, Any]:
        return {
            "available": espeak.available(),
            "languages": espeak.languages() if espeak.available() else [],
        }

    def _hello_result(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "protocol": PROTOCOL,
            "max_payload_bytes": MAX_PAYLOAD_BYTES,
            "limits": {
                "max_range_seconds": MAX_RANGE_SECONDS,
                "max_open_sources": MAX_OPEN_SOURCES,
            },
            "ipa": self._ipa_info(),
        }
        if "flac" in self._encoders:
            result["audio"] = {
                "codec": "flac",
                "rate": AUDIO_RATE,
                "channels": AUDIO_CHANNELS,
                "bits": AUDIO_BITS,
            }
        if "png" in self._encoders:
            result["video"] = {
                "codec": "png",
                "scales": list(VIDEO_SCALES),
                "fps": list(VIDEO_FPS),
            }
        return result

    async def _m_hello(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> dict[str, Any]:
        if connection in self._helloed:
            raise BackendError("bad-request", "hello was already sent on this connection")
        requested = params.get("protocol", PROTOCOL)
        if requested != PROTOCOL:
            raise BackendError(
                "protocol-mismatch",
                f"unsupported protocol {requested!r}",
                {"supported": PROTOCOL},
            )
        self._helloed.add(connection)
        self.log("hello", client=params.get("client"))
        return self._hello_result()

    # -- media sources -----------------------------------------------------

    async def _run(self, fn: Callable[..., Any], *args: Any) -> Any:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, fn, *args)

    def _get_source(self, source_id: str) -> OpenedSource:
        try:
            source = self._media.pop(source_id)
        except KeyError:
            raise sources.SourceError(
                "source-not-found",
                f"unknown source_id {source_id!r}",
                source_id=source_id,
            ) from None
        self._media[source_id] = source  # LRU touch
        return source

    def _source_view(self, source: OpenedSource) -> dict[str, Any]:
        streams: list[dict[str, Any]] = []
        if source.audio is not None:
            info = source.audio.info()
            streams.append(
                {
                    "index": AUDIO_STREAM_INDEX,
                    "kind": "audio",
                    "codec": info["codec"],
                    "sample_rate": info["sample_rate"],
                    "channels": info["channels"],
                    "total_samples": info["total_samples"],
                }
            )
        if source.video is not None:
            view = source.video.view()
            streams.append(
                {
                    "index": VIDEO_STREAM_INDEX,
                    "kind": "video",
                    "codec": view["codec"],
                    "width": view["width"],
                    "height": view["height"],
                    "fps": view["fps"],
                }
            )
        return {
            "source_id": source.id,
            "path": source.path,
            "duration_sec": round(source.duration_sec, 6),
            "streams": streams,
        }

    async def _m_open_source(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> dict[str, Any]:
        path = params.get("path")
        if not isinstance(path, str) or not path:
            raise BackendError("bad-request", "path must be a non-empty string")
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise BackendError(
                "source-not-found", f"no readable file at {path}", {"path": path}
            )
        audio: sources.Source | None = None
        try:
            audio = await self._run(sources.Source.open, path)
        except sources.SourceError as exc:
            if exc.code != "source-unsupported-media":
                raise
        video = await self._run(VideoFile.open, path)
        if audio is None and video is None:
            raise sources.SourceError(
                "source-unsupported-media",
                "file has neither an audio nor a video stream",
                path=path,
            )
        source = OpenedSource(path, audio, video)
        self._media[source.id] = source
        while len(self._media) > MAX_OPEN_SOURCES:
            _, evicted = self._media.popitem(last=False)
            evicted.close()
        self.log("source-open", source_id=source.id, path=path)
        return self._source_view(source)

    async def _m_close_source(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> dict[str, Any]:
        source_id = params.get("source_id")
        if not isinstance(source_id, str) or not source_id:
            raise BackendError("bad-request", "source_id must be a non-empty string")
        source = self._media.pop(source_id, None)
        if source is not None:
            await self._run(source.close)
        self.log("source-close", source_id=source_id)
        return {}

    async def _m_annotate(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> dict[str, Any]:
        text = params.get("text")
        if not isinstance(text, str) or not text:
            raise BackendError("bad-request", "text must be a non-empty string")
        language = params.get("language")
        if not isinstance(language, str) or not language:
            raise BackendError("bad-request", "language must be a non-empty string")
        target = params.get("target")
        if not isinstance(target, str) or not target:
            raise BackendError("bad-request", "target must be a non-empty string")
        result = await self._run(
            annotator.annotate, text, language.lower(), target.lower()
        )
        self.log(
            "annotate",
            language=language,
            target=target,
            units=len(result["units"]),
        )
        return result

    async def _m_request_range(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> None:
        source_id = params.get("source_id")
        if not isinstance(source_id, str) or not source_id:
            raise BackendError("bad-request", "source_id must be a non-empty string")
        kind = params.get("kind", "audio")
        if kind not in ("audio", "video"):
            raise BackendError("bad-request", f"unknown kind {kind!r}", {"kind": kind})
        start = _require_number(params, "start_sec")
        duration = _require_number(params, "duration_sec")
        if not math.isfinite(start) or not math.isfinite(duration):
            raise BackendError("bad-request", "start_sec/duration_sec must be finite")
        if start < 0:
            raise BackendError(
                "range-out-of-bounds", "start_sec must not be negative", {"start_sec": start}
            )
        if duration <= 0:
            raise BackendError("bad-request", "duration_sec must be positive")
        if duration > MAX_RANGE_SECONDS:
            raise BackendError(
                "range-too-large",
                f"one range may cover at most {MAX_RANGE_SECONDS} s",
                {"duration_sec": duration, "max_range_seconds": MAX_RANGE_SECONDS},
            )
        source = self._get_source(source_id)
        if kind == "audio":
            await self._send_audio_range(connection, msg_id, source, params, start, duration)
        else:
            await self._send_video_range(connection, msg_id, source, params, start, duration)

    async def _send_audio_range(
        self,
        connection: ServerConnection,
        msg_id: Any,
        source: OpenedSource,
        params: dict[str, Any],
        start: float,
        duration: float,
    ) -> None:
        stream = params.get("stream", AUDIO_STREAM_INDEX)
        if isinstance(stream, bool) or not isinstance(stream, int) or stream != AUDIO_STREAM_INDEX:
            raise BackendError(
                "bad-request",
                f"audio stream index is {AUDIO_STREAM_INDEX}",
                {"stream": stream},
            )
        if "flac" not in self._encoders:
            raise BackendError("unsupported-codec", "this av build has no FLAC encoder")
        audio = source.audio
        if audio is None:
            raise sources.SourceError(
                "source-unsupported-media", "file has no audio stream", source_id=source.id
            )
        total = audio.total_samples
        start_sample = min(int(round(start * AUDIO_RATE)), total)
        count = min(int(round(duration * AUDIO_RATE)), max(0, total - start_sample))

        if count == 0:
            data = b""
        else:
            pcm = await self._run(audio.read, start_sample, count)
            data = await self._run(encode_flac, pcm)

        packets = max(1, math.ceil(len(data) / MAX_PAYLOAD_BYTES))
        ack = {
            "req_id": msg_id,
            "start_sample": start_sample,
            "count": count,
            "bytes": len(data),
            "packets": packets,
        }
        await connection.send(
            json.dumps({"v": PROTOCOL, "id": msg_id, "ok": True, "result": ack})
        )

        slices = [
            data[i * MAX_PAYLOAD_BYTES : (i + 1) * MAX_PAYLOAD_BYTES]
            for i in range(packets)
        ]
        for index, payload in enumerate(slices, start=1):
            await connection.send(
                _header(
                    {
                        "req_id": msg_id,
                        "seq": index,
                        "last": index == packets,
                        "codec": "flac",
                    },
                    payload,
                )
            )
        self.log(
            "range",
            source_id=source.id,
            kind="audio",
            start_sample=start_sample,
            count=count,
            bytes=len(data),
        )

    async def _send_video_range(
        self,
        connection: ServerConnection,
        msg_id: Any,
        source: OpenedSource,
        params: dict[str, Any],
        start: float,
        duration: float,
    ) -> None:
        stream = params.get("stream", VIDEO_STREAM_INDEX)
        if isinstance(stream, bool) or not isinstance(stream, int) or stream != VIDEO_STREAM_INDEX:
            raise BackendError(
                "bad-request",
                f"video stream index is {VIDEO_STREAM_INDEX}",
                {"stream": stream},
            )
        if "png" not in self._encoders:
            raise BackendError("unsupported-codec", "this av build has no PNG encoder")
        video = source.video
        if video is None:
            raise sources.SourceError(
                "source-unsupported-media", "file has no video stream", source_id=source.id
            )
        scale = params.get("scale", VIDEO_DEFAULT_SCALE)
        if not _is_scale(scale):
            raise BackendError(
                "bad-request",
                "scale must be one of 1, 0.5, 0.3333, 0.25",
                {"scale": scale, "allowed": list(VIDEO_SCALES)},
            )
        fps = params.get("fps", VIDEO_DEFAULT_FPS)
        if isinstance(fps, bool) or not isinstance(fps, int) or fps not in VIDEO_FPS:
            raise BackendError(
                "bad-request",
                "fps must be one of 24, 30, 60",
                {"fps": fps, "allowed": list(VIDEO_FPS)},
            )

        start_eff = min(start, video.duration_sec)
        if start_eff >= video.duration_sec:
            start_eff = max(0.0, video.duration_sec - 1.0 / fps)
        frames = await self._run(
            video.read_window,
            start_eff,
            duration,
            fps,
            float(scale),
            MAX_PAYLOAD_BYTES,
        )
        start_pts_us = (
            frames[0]["pts_us"] if frames else int(round(start_eff * 1_000_000))
        )
        ack = {"req_id": msg_id, "start_pts_us": start_pts_us, "count": len(frames)}
        await connection.send(
            json.dumps({"v": PROTOCOL, "id": msg_id, "ok": True, "result": ack})
        )
        if not frames:
            await connection.send(
                _header(
                    {
                        "req_id": msg_id,
                        "seq": 1,
                        "last": True,
                        "codec": "png",
                        "pts_us": start_pts_us,
                        "frame_index": 0,
                        "width": 0,
                        "height": 0,
                    },
                    b"",
                )
            )
            return
        for index, frame in enumerate(frames, start=1):
            await connection.send(
                _header(
                    {
                        "req_id": msg_id,
                        "seq": index,
                        "last": index == len(frames),
                        "codec": "png",
                        "pts_us": frame["pts_us"],
                        "frame_index": frame["frame_index"],
                        "width": frame["width"],
                        "height": frame["height"],
                    },
                    frame["png"],
                )
            )
        self.log(
            "range",
            source_id=source.id,
            kind="video",
            start_pts_us=start_pts_us,
            count=len(frames),
        )

    # -- task board --------------------------------------------------------

    async def _m_task_submit(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> dict[str, Any]:
        kind = params.get("kind")
        if kind not in ("transcribe", "align"):
            raise BackendError(
                "unknown-task-kind",
                "kind must be transcribe or align",
                {"kind": kind},
            )
        inner = params.get("params")
        if not isinstance(inner, dict):
            raise BackendError("bad-request", "params.params must be an object")
        source_id = _require_string(inner, "source_id")
        stream = inner.get("stream", AUDIO_STREAM_INDEX)
        if (
            isinstance(stream, bool)
            or not isinstance(stream, int)
            or stream != AUDIO_STREAM_INDEX
        ):
            raise BackendError(
                "bad-request",
                f"stream must be the audio stream index {AUDIO_STREAM_INDEX}",
                {"stream": stream},
            )
        files = inner.get("files")
        if not isinstance(files, dict) or not files:
            raise BackendError("bad-request", "files must be a non-empty object")
        language = _require_string(inner, "language").lower()
        target = _require_string(inner, "target").lower()
        scope = inner.get("scope", "part")
        if scope not in ("all", "part"):
            raise BackendError(
                "bad-request", "scope must be all or part", {"scope": scope}
            )
        start_sec, end_sec = _task_range(inner.get("range"))
        source = self._get_source(source_id)

        if kind == "transcribe":
            vad = inner.get("vad", True)
            if not isinstance(vad, bool):
                raise BackendError("bad-request", "vad must be a boolean")

            def work(progress: Any, cancel: Any) -> Any:
                return taskboard.transcribe(
                    self._whisper,
                    source.path,
                    files,
                    language,
                    target,
                    scope,
                    vad,
                    start_sec,
                    end_sec,
                    progress,
                    cancel,
                )

        else:
            text = inner.get("text")
            if not isinstance(text, str) or not text.strip():
                raise BackendError("bad-request", "text must be a non-empty string")
            fast_mode = inner.get("fast_mode", False)
            if not isinstance(fast_mode, bool):
                raise BackendError("bad-request", "fast_mode must be a boolean")

            def work(progress: Any, cancel: Any) -> Any:
                return taskboard.align(
                    self._whisper,
                    source.path,
                    files,
                    text,
                    language,
                    target,
                    scope,
                    fast_mode,
                    start_sec,
                    end_sec,
                    progress,
                    cancel,
                )

        result = self.tasks.submit(kind, work)
        self.log(
            "task-submit",
            task_id=result["task_id"],
            kind=kind,
            source_id=source_id,
            language=language,
            target=target,
        )
        return result

    async def _m_task_cancel(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> dict[str, Any]:
        task_id = _require_string(params, "task_id")
        result = self.tasks.cancel(task_id)
        self.log("task-cancel", task_id=task_id, state=result["state"])
        return result

    async def _m_task_get(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> dict[str, Any]:
        return self.tasks.get(_require_string(params, "task_id"))

    async def _m_task_list(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> dict[str, Any]:
        kind = params.get("kind")
        if kind is not None and kind not in ("transcribe", "align"):
            raise BackendError(
                "unknown-task-kind",
                "kind must be transcribe or align",
                {"kind": kind},
            )
        state = params.get("state")
        if state is not None and state not in (
            "queued",
            "running",
            "done",
            "failed",
            "cancelled",
        ):
            raise BackendError("bad-request", "unknown state", {"state": state})
        return self.tasks.list(kind, state)

    # -- shutdown ----------------------------------------------------------

    async def _m_shutdown(
        self, connection: ServerConnection, msg_id: Any, params: dict[str, Any]
    ) -> None:
        await connection.send(
            json.dumps({"v": PROTOCOL, "id": msg_id, "ok": True, "result": {}})
        )
        self.log("shutdown", reason="in-band")
        await self.aclose()
        self.stopped.set()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            for source in self._media.values():
                source.close()
            self._media.clear()
        finally:
            self._executor.shutdown(wait=False, cancel_futures=True)
        for connection in list(self._connections):
            try:
                await connection.close(code=1001, reason="shutdown")
            except Exception:  # noqa: BLE001 - the peer may already be gone
                pass
        self._connections.clear()
        self._helloed.clear()


def _require_number(params: dict[str, Any], key: str) -> float:
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BackendError("bad-request", f"{key} must be a number")
    return float(value)


def _require_string(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise BackendError("bad-request", f"{key} must be a non-empty string")
    return value


def _task_range(value: Any) -> tuple[float, float | None]:
    """Read the optional ``range`` object of task.submit (api.md 8.2/8.3)."""
    if value is None:
        return 0.0, None
    if not isinstance(value, dict):
        raise BackendError("bad-request", "range must be an object")
    start = value.get("start_sec", 0.0)
    if isinstance(start, bool) or not isinstance(start, (int, float)):
        raise BackendError("bad-request", "range.start_sec must be a number")
    start_sec = float(start)
    if not math.isfinite(start_sec) or start_sec < 0:
        raise BackendError(
            "range-out-of-bounds",
            "range.start_sec must be a finite non-negative number",
            {"start_sec": start_sec},
        )
    end = value.get("end_sec")
    if end is None:
        return start_sec, None
    if isinstance(end, bool) or not isinstance(end, (int, float)):
        raise BackendError("bad-request", "range.end_sec must be a number")
    end_sec = float(end)
    if not math.isfinite(end_sec) or end_sec <= start_sec:
        raise BackendError(
            "bad-request", "range.end_sec must be greater than range.start_sec"
        )
    return start_sec, end_sec


def _is_scale(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    number = float(value)
    return any(math.isclose(number, allowed, rel_tol=1e-3) for allowed in VIDEO_SCALES)


async def run_service(service: BackendService, host: str = "127.0.0.1", port: int = 0) -> Server:
    """Bind and return the server; the caller hands out the port."""
    service._loop = asyncio.get_running_loop()  # noqa: SLF001 - the service owns it
    server = await ws_serve(service.handler, host, port, compression=None)
    service.attach(server)
    service.tasks.start()
    return server
