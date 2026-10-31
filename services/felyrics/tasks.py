"""Serial task board for ``transcribe`` and ``align`` (api.md sections 8, 10).

One worker thread runs one task at a time. Media decoding happens inside the
task (it is part of the work), inference holds the worker, and every heavy
step reports progress. Events are emitted from the worker thread; the server
turns them into websocket broadcasts on the event loop.
"""

from __future__ import annotations

import itertools
import json
import os
import queue
import threading
import time
from collections import OrderedDict
from typing import Any, Callable

import av
import numpy as np

from . import annotate as annotator
from .annotate import AnnotationError

WHISPER_RATE = 16000
MAX_WAITING = 8
MODEL_CACHE = 2
PROGRESS_INTERVAL = 0.1
DECODE_PREROLL_SEC = 1.0

REQUIRED_FILES = ("model.bin", "config.json", "tokenizer.json")
VOCABULARY_FILES = ("vocabulary.txt", "vocabulary.json")


class TaskError(Exception):
    """A task failure carrying a code from api.md section 12."""

    def __init__(self, code: str, message: str, data: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data: dict[str, Any] = dict(data) if data else {}


class TaskCancelled(Exception):
    """Raised inside a running task when the cancellation flag is set."""


# -- decoding ---------------------------------------------------------------


def _seek_ticks(start_sec: float, time_base: float) -> int:
    """PyAV seek offsets are stream time-base units, never samples."""
    return int(round(start_sec / time_base))


def decode_pcm16k(path: str, start_sec: float = 0.0, end_sec: float | None = None) -> np.ndarray:
    """Decode ``[start_sec, end_sec)`` as 16 kHz mono float32.

    faster-whisper must receive an ndarray, never a path: its audio loader calls
    ``av.open(metadata_errors="ignore")``, which av 19 rejects (api.md 8.2).
    """
    with av.open(path) as container:
        if not container.streams.audio:
            raise TaskError(
                "source-unsupported-media", "file has no audio stream", {"path": path}
            )
        stream = container.streams.audio[0]
        time_base = float(stream.time_base or 0.0)
        if start_sec > DECODE_PREROLL_SEC and time_base > 0:
            # Seek a little before the target so the resampler is warm when
            # the window starts; the extra samples are dropped by ``skip``.
            # Offsets are stream time-base units, not samples: 60 s on a
            # 1/14112000 mp3 stream is 846720000 ticks, not 2880000.
            container.seek(
                _seek_ticks(start_sec - DECODE_PREROLL_SEC, time_base),
                stream=stream,
                backward=True,
            )
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=WHISPER_RATE)
        chunks: list[np.ndarray] = []
        origin_sec: float | None = None
        stream_start = float(stream.start_time or 0) * time_base
        skip: int | None = None
        limit: int | None = None
        if end_sec is not None:
            limit = max(0, int(round((end_sec - start_sec) * WHISPER_RATE)))
        collected = 0
        for frame in container.decode(stream):
            if origin_sec is None and frame.pts is not None and time_base:
                origin_sec = float(frame.pts) * time_base - stream_start
                skip = max(0, int(round((start_sec - origin_sec) * WHISPER_RATE)))
            for converted in resampler.resample(frame):
                array = converted.to_ndarray().reshape(-1)
                chunks.append(array)
                collected += array.size
            if limit is not None and skip is not None and collected >= skip + limit:
                break
        for converted in resampler.resample(None):
            chunks.append(converted.to_ndarray().reshape(-1))
    if not chunks:
        raise TaskError(
            "source-decode-failed", "decoder produced no samples", {"path": path}
        )
    pcm = np.concatenate(chunks).astype(np.float32, copy=False)
    if origin_sec is None:
        origin_sec = 0.0
    if skip is None:
        skip = max(0, int(round((start_sec - origin_sec) * WHISPER_RATE)))
    pcm = pcm[skip:]
    if end_sec is not None:
        limit = max(0, int(round((end_sec - start_sec) * WHISPER_RATE)))
        pcm = pcm[:limit]
    return np.ascontiguousarray(pcm, dtype=np.float32)


# -- model files ------------------------------------------------------------


def _read_files(files: Any) -> dict[str, bytes]:
    if not isinstance(files, dict) or not files:
        raise TaskError("bad-request", "files must be a non-empty object")
    missing = [name for name in REQUIRED_FILES if name not in files]
    if not any(name in files for name in VOCABULARY_FILES):
        missing.append("vocabulary.txt or vocabulary.json")
    unreadable: list[str] = []
    data: dict[str, bytes] = {}
    for name, path in files.items():
        if not isinstance(name, str) or not isinstance(path, str) or not path:
            raise TaskError("bad-request", "files must map names to paths", {"name": name})
        if name not in REQUIRED_FILES + VOCABULARY_FILES + ("preprocessor_config.json", "README.md"):
            raise TaskError(
                "bad-request", f"unexpected model file {name!r}", {"name": name}
            )
        try:
            with open(path, "rb") as handle:
                data[name] = handle.read()
        except OSError:
            unreadable.append(name)
    if missing or unreadable:
        raise TaskError(
            "model-file-missing",
            "required model files are missing or unreadable",
            {"missing": missing + unreadable},
        )
    feature_size = _feature_size(data.get("config.json"))
    if feature_size == 128 and "preprocessor_config.json" not in data:
        # faster-whisper silently falls back to 80 mel bins without it
        # (api.md 8.1), which decodes to noise for large-v3.
        raise TaskError(
            "model-file-missing",
            "this model needs preprocessor_config.json (feature_size 128)",
            {"missing": ["preprocessor_config.json"]},
        )
    return data


def _feature_size(raw: bytes | None) -> int | None:
    if not raw:
        return None
    try:
        value = json.loads(raw.decode("utf-8")).get("feature_size")
    except (UnicodeDecodeError, ValueError, AttributeError):
        return None
    return int(value) if isinstance(value, int) else None


def _files_key(files: dict[str, Any]) -> str:
    parts = []
    for name in sorted(files):
        path = files[name]
        if not isinstance(name, str) or not isinstance(path, str) or not path:
            # The client supplies this map; a non-string path must be a
            # bad-request, not an internal-error from os.path.realpath.
            raise TaskError(
                "bad-request", "model file paths must be strings", {"name": name}
            )
        resolved = os.path.realpath(path)
        try:
            stat = os.stat(resolved)
            parts.append(f"{name}:{resolved}:{stat.st_size}:{int(stat.st_mtime)}")
        except OSError:
            parts.append(f"{name}:{resolved}:?")
    return "|".join(parts)


class WhisperStore:
    """Loaded whisper models, LRU 2, keyed by the resolved file list.

    The model bytes are cached once per file list (large-v3 is 3 GB) and every
    load receives a shallow copy, because ``faster_whisper`` pops keys from the
    dict it is handed (``transcribe.py:676-677``).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._masters: OrderedDict[str, dict[str, bytes]] = OrderedDict()
        self._models: OrderedDict[tuple[str, str], Any] = OrderedDict()

    def _master(self, key: str, files: dict[str, Any]) -> dict[str, bytes]:
        with self._lock:
            if key in self._masters:
                self._masters.move_to_end(key)
                return self._masters[key]
        data = _read_files(files)
        with self._lock:
            self._masters[key] = data
            self._evict_masters()
        return data

    def _evict_masters(self) -> None:
        while len(self._masters) > MODEL_CACHE:
            drop, _ = self._masters.popitem(last=False)
            for cache_key in list(self._models):
                if cache_key[1] == drop:
                    self._models.pop(cache_key, None)

    def _load(self, flavor: str, files: dict[str, Any]) -> Any:
        key = _files_key(files)
        cache_key = (flavor, key)
        with self._lock:
            if cache_key in self._models:
                self._models.move_to_end(cache_key)
                return self._models[cache_key]
        master = self._master(key, files)
        try:
            if flavor == "stable":
                import stable_whisper

                model = stable_whisper.load_faster_whisper(
                    key, device="cpu", compute_type="int8", files=dict(master)
                )
            else:
                from faster_whisper import WhisperModel

                model = WhisperModel(
                    key, device="cpu", compute_type="int8", files=dict(master)
                )
        except Exception as exc:  # noqa: BLE001 - ctranslate2 raises broadly
            raise TaskError(
                "model-load-failed", f"could not load the model: {exc}"
            ) from exc
        with self._lock:
            self._models[cache_key] = model
            while len(self._models) > MODEL_CACHE:
                self._models.popitem(last=False)
        return model

    def transcribe_model(self, files: dict[str, Any]) -> Any:
        return self._load("fw", files)

    def align_model(self, files: dict[str, Any]) -> Any:
        return self._load("stable", files)


# -- annotation attachment --------------------------------------------------


def _word_syllables(word: str, language: str, target: str) -> list[str] | None:
    text = word.strip()
    if not text:
        return None
    units = annotator.annotate(text, language, target)["units"]
    syllables = [syllable for unit in units for syllable in unit["syllables"]]
    if not syllables:
        return None
    return syllables


def _word_spans(
    text: str, words: list[dict[str, Any]]
) -> list[tuple[int, int]] | None:
    """Locate each word inside its segment text, in order.

    Returns None when a word cannot be found verbatim: the caller then falls
    back to annotating that word on its own, because slicing by a guessed span
    could hand a word another word's phonemes.
    """
    spans: list[tuple[int, int]] = []
    cursor = 0
    for word in words:
        token = (word.get("word") or "").strip()
        if not token:
            return None
        start = text.find(token, cursor)
        if start < 0:
            return None
        spans.append((start, start + len(token)))
        cursor = start + len(token)
    return spans


def _span_syllables(
    units: list[dict[str, Any]], span: tuple[int, int]
) -> list[str] | None:
    """Collect the syllables of the units that cover one word's span exactly.

    A word boundary that cuts through a unit (a Latin word inside a Japanese
    kanji run, say) must not yield a partial list: the caller then falls back to
    annotating that single word.
    """
    start, end = span
    syllables: list[str] = []
    cursor = start
    for unit in units:
        if cursor == end:
            break
        offset = unit["offset"]
        if offset < start:
            continue
        if offset != cursor:
            return None
        cursor = offset + len(unit["text"])
        if cursor > end:
            return None
        syllables.extend(unit["syllables"])
    if cursor != end:
        return None
    return syllables or None


def _segment_units(
    text: str, language: str, target: str
) -> list[dict[str, Any]] | None:
    """Annotate a whole segment once and return its units, if they are sliceable.

    ``annotate`` reports integer ``offset``s that tile the input text in order,
    so one call per segment replaces one espeak-ng subprocess per word under the
    ipa target (api.md 9.4.1). A unit without an integer offset breaks that
    contract, and then the caller must stay on the per-word path.
    """
    if not text:
        return None
    units = annotator.annotate(text, language, target)["units"]
    if any(not isinstance(unit.get("offset"), int) for unit in units):
        return None
    return units


def _attach_syllables(
    segments: list[dict[str, Any]],
    language: str,
    target: str,
    scope: str,
    cancel: threading.Event | None = None,
) -> None:
    for segment in segments:
        if cancel is not None and cancel.is_set():
            raise TaskCancelled()
        words = segment.get("words") or []
        if not words:
            continue
        text = segment.get("text") or ""
        spans = _word_spans(text, words) if text else None
        units = _segment_units(text, language, target) if spans is not None else None
        for index, word in enumerate(words):
            syllables = None
            if units is not None and spans is not None:
                syllables = _span_syllables(units, spans[index])
            if syllables is None:
                syllables = _word_syllables(word["word"], language, target)
            if syllables is None:
                continue
            if scope == "part" and all(
                syllable == word["word"].strip()
                for syllable in syllables
            ):
                continue
            word["syllables"] = syllables


# -- transcribe -------------------------------------------------------------


def transcribe(
    store: WhisperStore,
    path: str,
    files: dict[str, Any],
    language: str,
    target: str,
    scope: str = "part",
    vad: bool = True,
    start_sec: float = 0.0,
    end_sec: float | None = None,
    progress: Callable[..., None] | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    """Run faster-whisper and return the AlignmentResult-shaped object."""

    def report(done: float, total: float, stage: str = "recognize") -> None:
        if progress is not None:
            progress(done, total, "samples", stage)

    if cancel is not None and cancel.is_set():
        raise TaskCancelled()
    report(0.0, 1.0, "decode")
    pcm = decode_pcm16k(path, start_sec, end_sec)
    total = float(len(pcm))
    report(0.0, total)

    model = store.transcribe_model(files)
    segments_iter, info = model.transcribe(
        pcm,
        language=language,
        task="transcribe",
        vad_filter=vad,
        word_timestamps=True,
    )
    segments: list[dict[str, Any]] = []
    texts: list[str] = []
    for segment in segments_iter:
        if cancel is not None and cancel.is_set():
            raise TaskCancelled()
        texts.append(segment.text)
        words = []
        for word in segment.words or []:
            words.append(
                {
                    "word": word.word,
                    "tokens": [],
                    "start": float(word.start),
                    "end": float(word.end),
                    "probability": float(word.probability),
                }
            )
        segments.append(
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": segment.text,
                "seek": int(segment.seek),
                "tokens": list(segment.tokens or []),
                "temperature": float(segment.temperature or 0.0),
                "avg_logprob": float(segment.avg_logprob),
                "compression_ratio": float(segment.compression_ratio),
                "no_speech_prob": float(segment.no_speech_prob),
                "words": words,
            }
        )
        report(min(total, float(segment.end) * WHISPER_RATE), total)

    if not segments:
        raise TaskError("align-failed", "no speech was recognised", {"placed": 0})

    _shift_times(segments, start_sec)
    _attach_syllables(segments, language, target, scope, cancel=cancel)
    return {
        "text": "".join(texts).strip(),
        "segments": segments,
        "language": info.language or language,
        "ori_dict": {},
        "regroup_history": [],
        "nonspeech_sections": [],
    }


# -- align ------------------------------------------------------------------


def _num(value: Any) -> Any:
    if isinstance(value, (np.floating, np.integer)):
        return float(value)
    if isinstance(value, list):
        return [_num(item) for item in value]
    if isinstance(value, dict):
        return {key: _num(item) for key, item in value.items()}
    return value


def _shift_times(segments: list[dict[str, Any]], offset: float) -> None:
    """Move segment and word times from the decoded window to the source.

    The model only sees the samples that start at ``start_sec``; its times are
    relative to that window. Task results are file-relative (api.md 6), so the
    window origin is added once, here.
    """
    if offset == 0.0:
        return
    for segment in segments:
        for key in ("start", "end"):
            value = segment.get(key)
            if isinstance(value, (int, float)):
                segment[key] = float(value) + offset
        for word in segment.get("words") or []:
            for key in ("start", "end"):
                value = word.get(key)
                if isinstance(value, (int, float)):
                    word[key] = float(value) + offset


def _shift_mapping(value: Any, offset: float) -> None:
    """Add ``offset`` to every nested ``start``/``end`` stable-ts mapping.

    ``ori_dict`` and ``nonspeech_sections`` carry their own timestamps; a ranged
    alignment decodes only the window, so those stay window-relative unless they
    are shifted like the segments (api.md 6).
    """
    if offset == 0.0:
        return
    if isinstance(value, dict):
        for key in ("start", "end"):
            item = value.get(key)
            if isinstance(item, (int, float)) and not isinstance(item, bool):
                value[key] = float(item) + offset
        for item in value.values():
            _shift_mapping(item, offset)
    elif isinstance(value, list):
        for item in value:
            _shift_mapping(item, offset)


def _check_alignment(data: dict[str, Any]) -> None:
    words = [
        word
        for segment in data.get("segments") or []
        for word in segment.get("words") or []
    ]
    if not words:
        raise TaskError("align-failed", "alignment produced no words", {"placed": 0})
    # stable-ts parks words it could not place at the end of the audio as
    # zero-length, probability-0 words (alignment.py:342-355). Only those are
    # a failure; a zero-length word elsewhere (punctuation) is normal.
    total_end = max(float(word["end"]) for word in words)
    unplaced = [
        word
        for word in words
        if float(word["start"]) == float(word["end"]) == total_end
        and float(word["probability"]) == 0.0
    ]
    if unplaced:
        raise TaskError(
            "align-failed",
            "the text did not fit the audio at its end",
            {"placed": len(words) - len(unplaced), "unplaced": len(unplaced)},
        )


def align(
    store: WhisperStore,
    path: str,
    files: dict[str, Any],
    text: str,
    language: str,
    target: str,
    scope: str = "part",
    fast_mode: bool = False,
    start_sec: float = 0.0,
    end_sec: float | None = None,
    progress: Callable[..., None] | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    """Run stable-ts ``align`` and return the AlignmentResult-shaped object."""
    if not isinstance(text, str) or not text.strip():
        raise TaskError("bad-request", "text must be a non-empty string")

    def report(done: float, total: float, stage: str) -> None:
        if progress is not None:
            progress(done, total, "units", stage)

    if cancel is not None and cancel.is_set():
        raise TaskCancelled()
    report(0.0, 1.0, "decode")
    pcm = decode_pcm16k(path, start_sec, end_sec)
    model = store.align_model(files)
    if cancel is not None and cancel.is_set():
        raise TaskCancelled()
    report(0.0, 1.0, "align")
    try:
        # fast_mode is a keyword-only option of stable_whisper.alignment.align;
        # api.md 8.3 promises the service forwards it (word grouping).
        result = model.align(
            pcm,
            text.strip(),
            language=language,
            remove_instant_words=False,
            fast_mode=bool(fast_mode),
        )
    except Exception as exc:  # noqa: BLE001 - stable-ts raises broadly
        raise TaskError("align-failed", f"alignment failed: {exc}") from exc
    if cancel is not None and cancel.is_set():
        raise TaskCancelled()
    if result is None:
        raise TaskError("align-failed", "alignment returned nothing", {"placed": 0})
    data = _num(result.to_dict())
    _check_alignment(data)
    _shift_times(data.get("segments") or [], start_sec)
    _shift_mapping(data.get("ori_dict") or {}, start_sec)
    _shift_mapping(data.get("nonspeech_sections") or [], start_sec)
    _attach_syllables(
        data.get("segments") or [], language, target, scope, cancel=cancel
    )
    data["language"] = data.get("language") or language
    report(1.0, 1.0, "annotate")
    return data


# -- board ------------------------------------------------------------------


class TaskBoard:
    """FIFO queue of inference tasks executed on one worker thread."""

    def __init__(self, emit: Callable[[str, dict[str, Any]], None]) -> None:
        self._emit = emit
        self._queue: queue.Queue[tuple[str, Callable[..., Any]]] = queue.Queue()
        self._tasks: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._cancels: dict[str, threading.Event] = {}
        self._last_emit: dict[str, float] = {}
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._thread = threading.Thread(
            target=self._run, name="task-worker", daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def submit(self, kind: str, work: Callable[..., Any]) -> dict[str, Any]:
        with self._lock:
            waiting = sum(
                1 for task in self._tasks.values() if task["state"] == "queued"
            )
            if waiting >= MAX_WAITING:
                raise TaskError(
                    "queued-full",
                    f"the board already holds {MAX_WAITING} waiting tasks",
                    {"max_waiting": MAX_WAITING},
                )
            task_id = f"t{next(self._ids)}"
            self._tasks[task_id] = {
                "task_id": task_id,
                "kind": kind,
                "state": "queued",
                "progress": None,
                "result": None,
                "error": None,
            }
            self._cancels[task_id] = threading.Event()
            position = waiting + 1
        self._queue.put((task_id, work))
        return {"task_id": task_id, "kind": kind, "state": "queued", "position": position}

    def get(self, task_id: str) -> dict[str, Any]:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise TaskError("task-not-found", f"unknown task_id {task_id!r}")
            return self._public(task)

    def list(self, kind: str | None = None, state: str | None = None) -> dict[str, Any]:
        with self._lock:
            tasks = [
                self._public(task, with_result=False)
                for task in self._tasks.values()
                if (kind is None or task["kind"] == kind)
                and (state is None or task["state"] == state)
            ]
        return {"tasks": tasks}

    def cancel(self, task_id: str) -> dict[str, Any]:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise TaskError("task-not-found", f"unknown task_id {task_id!r}")
            if task["state"] == "queued":
                task["state"] = "cancelled"
            self._cancels[task_id].set()
            return {"task_id": task_id, "state": task["state"]}

    def close(self, timeout_sec: float = 0.5) -> None:
        """Stop the worker and cancel whatever it is doing.

        The running task aborts at its next cancellation check; the thread is a
        daemon, so the join timeout only bounds how long shutdown waits for a
        cooperative stop. Queued tasks are marked cancelled so their events
        never fire after the connection is gone (api.md 4.3).
        """
        with self._lock:
            for task in self._tasks.values():
                if task["state"] == "queued":
                    task["state"] = "cancelled"
            for event in self._cancels.values():
                event.set()
        self._queue.put(None)
        if self._thread.is_alive():
            self._thread.join(timeout=timeout_sec)

    @staticmethod
    def _public(task: dict[str, Any], with_result: bool = True) -> dict[str, Any]:
        view = {
            "task_id": task["task_id"],
            "kind": task["kind"],
            "state": task["state"],
            "progress": task["progress"],
        }
        if with_result and task["result"] is not None:
            view["result"] = task["result"]
        if task["error"] is not None:
            view["error"] = task["error"]
        return view

    def _progress(
        self, task_id: str, done: float, total: float, unit: str, stage: str
    ) -> None:
        progress = {
            "stage": stage,
            "done": float(done),
            "total": float(total),
            "unit": unit,
        }
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return
            task["progress"] = progress
            now = time.monotonic()
            last = self._last_emit.get(task_id, 0.0)
            if now - last < PROGRESS_INTERVAL:
                return
            self._last_emit[task_id] = now
            kind = task["kind"]
        self._emit(
            "task.progress",
            {
                "task_id": task_id,
                "kind": kind,
                "stage": progress["stage"],
                "done": progress["done"],
                "total": progress["total"],
                "unit": progress["unit"],
            },
        )

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            task_id, work = item
            with self._lock:
                task = self._tasks.get(task_id)
                if task is None or task["state"] != "queued":
                    continue
                task["state"] = "running"
                kind = task["kind"]
            cancel = self._cancels[task_id]
            emit = self._emit

            def progress(done: float, total: float, unit: str, stage: str) -> None:
                self._progress(task_id, done, total, unit, stage)

            try:
                result = work(progress, cancel)
            except TaskCancelled:
                with self._lock:
                    task["state"] = "cancelled"
                continue
            except (TaskError, AnnotationError) as exc:
                error = {"code": exc.code, "message": exc.message}
                if exc.data:
                    error["data"] = exc.data
                with self._lock:
                    task["state"] = "failed"
                    task["error"] = error
                emit("task.failed", {"task_id": task_id, "kind": kind, "error": error})
            except Exception as exc:  # noqa: BLE001 - last resort
                error = {"code": "internal-error", "message": "internal error", "data": {"detail": repr(exc)}}
                with self._lock:
                    task["state"] = "failed"
                    task["error"] = error
                emit("task.failed", {"task_id": task_id, "kind": kind, "error": error})
            else:
                with self._lock:
                    task["state"] = "done"
                    task["result"] = result
                emit("task.done", {"task_id": task_id, "kind": kind, "result": result})
