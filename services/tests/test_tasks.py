"""Checks for ``services/felyrics/tasks.py`` and the server-side task board.

The board is exercised directly (worker thread, cancellation, queue cap) and
through the real service over loopback with the models stubbed, so the suite
never loads a whisper checkpoint.

Run:
  python\\python.exe -m pytest services\\tests -q -p no:cacheprovider
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import numpy as np
import pytest
from websockets.sync.client import connect

from felyrics import tasks
from felyrics.tasks import TaskError
from felyrics.server import BackendService, run_service

REPO = Path(__file__).resolve().parents[2]
MP3 = REPO / "tests" / "song.mp3"
TOKEN = "task-token"


# -- helpers ----------------------------------------------------------------


class Recorder:
    """Collects board events in the order the worker emitted them."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []
        self.lock = threading.Lock()

    def __call__(self, event: str, payload: dict) -> None:
        with self.lock:
            self.events.append((event, payload))

    def names(self) -> list[str]:
        with self.lock:
            return [event for event, _ in self.events]


def wait_for(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class ServerThread:
    """Runs the real service on an ephemeral port in a background loop."""

    def __init__(self) -> None:
        self.service = BackendService(token=TOKEN)
        self.loop = asyncio.new_event_loop()
        self.port: int | None = None
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self._run, name="service", daemon=True)
        self.thread.start()
        assert self.ready.wait(10), "service did not start"

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)

        async def main() -> None:
            server = await run_service(self.service, "127.0.0.1", 0)
            self.port = server.sockets[0].getsockname()[1]
            self.ready.set()
            await self.service.stopped.wait()
            await self.service.aclose()
            server.close()
            await server.wait_closed()

        try:
            self.loop.run_until_complete(main())
        finally:
            self.loop.close()

    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/?token={TOKEN}"

    def stop(self) -> None:
        self.loop.call_soon_threadsafe(self.service.stopped.set)
        self.thread.join(10)


@pytest.fixture()
def server() -> ServerThread:
    thread = ServerThread()
    try:
        yield thread
    finally:
        thread.stop()


@pytest.fixture()
def socket(server: ServerThread):
    with connect(server.url(), proxy=None) as connection:
        yield connection


def send(connection, payload: dict) -> None:
    connection.send(json.dumps(payload))


def recv(connection, timeout: float = 10.0) -> dict:
    return json.loads(connection.recv(timeout=timeout))


def request(connection, msg_id: str, method: str, params: dict | None = None) -> dict:
    send(connection, {"v": 1, "id": msg_id, "method": method, "params": params or {}})
    return recv(connection)


def event_until(connection, name: str) -> dict:
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        message = recv(connection)
        if message.get("type") == "event" and message.get("event") == name:
            return message
    raise AssertionError(f"no {name} event arrived")


# -- fakes ------------------------------------------------------------------


class FakeWord:
    def __init__(self, word: str, start: float, end: float) -> None:
        self.word = word
        self.start = start
        self.end = end
        self.probability = 0.9


class FakeSegment:
    def __init__(self) -> None:
        self.id = 0
        self.seek = 0
        self.start = 0.0
        self.end = 1.0
        self.text = "こんにちは"
        self.tokens = [1, 2]
        self.temperature = 0.0
        self.avg_logprob = -0.1
        self.compression_ratio = 1.0
        self.no_speech_prob = 0.01
        self.words = [FakeWord("こんにちは", 0.0, 1.0)]


class FakeInfo:
    language = "ja"


class FakeTranscribeModel:
    def transcribe(self, audio, **kwargs):
        return iter([FakeSegment()]), FakeInfo()


class FakeAlignModel:
    def align(self, audio, text, **kwargs):
        return None


@pytest.fixture()
def stub_models(monkeypatch):
    monkeypatch.setattr(
        tasks, "decode_pcm16k", lambda path, start=0.0, end=None: np.zeros(16000, np.float32)
    )
    monkeypatch.setattr(
        tasks.WhisperStore, "transcribe_model", lambda self, files: FakeTranscribeModel()
    )
    monkeypatch.setattr(
        tasks.WhisperStore, "align_model", lambda self, files: FakeAlignModel()
    )
    yield


# -- board unit tests -------------------------------------------------------


def test_board_runs_task_and_emits_events() -> None:
    recorder = Recorder()
    board = tasks.TaskBoard(recorder)
    board.start()

    def work(progress, cancel):
        progress(0.5, 1.0, "samples", "recognize")
        return {"ok": True}

    task = board.submit("transcribe", work)
    assert task["state"] == "queued"
    assert wait_for(lambda: board.get(task["task_id"])["state"] == "done")
    done = board.get(task["task_id"])
    assert done["result"] == {"ok": True}
    assert "task.progress" in recorder.names()
    assert "task.done" in recorder.names()
    listed = board.list()
    assert listed["tasks"][0]["task_id"] == task["task_id"]
    assert "result" not in listed["tasks"][0]


def test_board_queue_cap() -> None:
    recorder = Recorder()
    board = tasks.TaskBoard(recorder)
    board.start()
    gate = threading.Event()
    first = board.submit("transcribe", lambda progress, cancel: gate.wait(5) and {})
    assert wait_for(lambda: board.get(first["task_id"])["state"] == "running")
    for _ in range(tasks.MAX_WAITING):
        board.submit("align", lambda progress, cancel: {})
    with pytest.raises(tasks.TaskError) as caught:
        board.submit("align", lambda progress, cancel: {})
    assert caught.value.code == "queued-full"
    gate.set()


def test_board_cancel_queued() -> None:
    recorder = Recorder()
    board = tasks.TaskBoard(recorder)
    board.start()
    gate = threading.Event()
    first = board.submit("transcribe", lambda progress, cancel: gate.wait(5) and {})
    assert wait_for(lambda: board.get(first["task_id"])["state"] == "running")
    second = board.submit("align", lambda progress, cancel: {})
    assert board.cancel(second["task_id"])["state"] == "cancelled"
    gate.set()
    assert wait_for(lambda: board.get(first["task_id"])["state"] == "done")
    assert board.get(second["task_id"])["state"] == "cancelled"


def test_board_cancel_running() -> None:
    recorder = Recorder()
    board = tasks.TaskBoard(recorder)
    board.start()
    started = threading.Event()

    def work(progress, cancel):
        started.set()
        while not cancel.is_set():
            time.sleep(0.01)
        raise tasks.TaskCancelled()

    task = board.submit("transcribe", work)
    assert started.wait(5)
    board.cancel(task["task_id"])
    assert wait_for(lambda: board.get(task["task_id"])["state"] == "cancelled")


def test_board_failure_event() -> None:
    recorder = Recorder()
    board = tasks.TaskBoard(recorder)
    board.start()

    def work(progress, cancel):
        raise tasks.TaskError("model-load-failed", "boom")

    task = board.submit("transcribe", work)
    assert wait_for(lambda: board.get(task["task_id"])["state"] == "failed")
    view = board.get(task["task_id"])
    assert view["error"]["code"] == "model-load-failed"
    failed = [payload for name, payload in recorder.events if name == "task.failed"]
    assert failed[0]["error"]["code"] == "model-load-failed"


# -- server level -----------------------------------------------------------


def _submit_transcribe(connection, source_id: str, msg_id: str) -> dict:
    return request(
        connection,
        msg_id,
        "task.submit",
        {
            "kind": "transcribe",
            "params": {
                "source_id": source_id,
                "stream": 0,
                "files": {"model.bin": str(MP3)},
                "language": "ja",
                "target": "hiragana",
            },
        },
    )


def test_server_transcribe_event_flow(server: ServerThread, socket, stub_models) -> None:
    hello = request(socket, "0", "hello", {"protocol": 1})
    assert hello["ok"] is True
    opened = request(socket, "1", "open_source", {"path": str(MP3)})
    source_id = opened["result"]["source_id"]

    submitted = _submit_transcribe(socket, source_id, "2")
    assert submitted["ok"] is True, submitted
    task_id = submitted["result"]["task_id"]
    assert submitted["result"]["state"] in ("queued", "running")

    done = event_until(socket, "task.done")
    assert done["task_id"] == task_id
    assert done["data"]["kind"] == "transcribe"
    result = done["data"]["result"]
    assert result["language"] == "ja"
    words = result["segments"][0]["words"]
    assert words[0]["syllables"] == ["こ", "ん", "に", "ち", "は"]

    replay = request(socket, "3", "task.get", {"task_id": task_id})
    assert replay["result"]["state"] == "done"
    assert replay["result"]["result"]["segments"][0]["words"][0]["syllables"] == [
        "こ",
        "ん",
        "に",
        "ち",
        "は",
    ]
    listed = request(socket, "4", "task.list", {})
    assert "result" not in listed["result"]["tasks"][0]


def test_server_align_failure_event(server: ServerThread, socket, stub_models) -> None:
    request(socket, "0", "hello", {"protocol": 1})
    opened = request(socket, "1", "open_source", {"path": str(MP3)})
    source_id = opened["result"]["source_id"]
    submitted = request(
        socket,
        "2",
        "task.submit",
        {
            "kind": "align",
            "params": {
                "source_id": source_id,
                "files": {"model.bin": str(MP3)},
                "language": "ja",
                "target": "hiragana",
                "text": "こんにちは",
            },
        },
    )
    assert submitted["ok"] is True, submitted
    failed = event_until(socket, "task.failed")
    assert failed["task_id"] == submitted["result"]["task_id"]
    assert failed["data"]["error"]["code"] == "align-failed"


def test_server_task_submit_validation(server: ServerThread, socket) -> None:
    request(socket, "0", "hello", {"protocol": 1})
    opened = request(socket, "1", "open_source", {"path": str(MP3)})
    source_id = opened["result"]["source_id"]
    base = {
        "source_id": source_id,
        "files": {"model.bin": str(MP3)},
        "language": "ja",
        "target": "hiragana",
    }

    bad_kind = request(socket, "2", "task.submit", {"kind": "separate", "params": base})
    assert bad_kind["error"]["code"] == "unknown-task-kind"

    missing_text = request(socket, "3", "task.submit", {"kind": "align", "params": base})
    assert missing_text["error"]["code"] == "bad-request"

    bad_scope = request(
        socket,
        "4",
        "task.submit",
        {"kind": "transcribe", "params": {**base, "scope": "some"}},
    )
    assert bad_scope["error"]["code"] == "bad-request"

    bad_range = request(
        socket,
        "5",
        "task.submit",
        {"kind": "transcribe", "params": {**base, "range": {"start_sec": -1}}},
    )
    assert bad_range["error"]["code"] == "range-out-of-bounds"

    unknown_source = request(
        socket,
        "6",
        "task.submit",
        {"kind": "transcribe", "params": {**base, "source_id": "nope"}},
    )
    assert unknown_source["error"]["code"] == "source-not-found"


# -- decoding ---------------------------------------------------------------


def test_seek_ticks_uses_stream_time_base() -> None:
    assert tasks._seek_ticks(60.0, 1 / 14112000) == 846_720_000
    assert tasks._seek_ticks(60.0, 1 / 1000) == 60_000


def test_decode_window_matches_full_decode() -> None:
    full = tasks.decode_pcm16k(str(MP3))
    window = tasks.decode_pcm16k(str(MP3), 100.0, 100.5)
    assert window.size == 8000
    reference = full[100 * 16000 : 100 * 16000 + 8000]
    assert reference.size == 8000
    # A seek restarts the mp3 decoder mid-frame, so the window is not
    # bit-exact with a continuous decode; it must still be the same audio.
    correlation = float(np.corrcoef(window, reference)[0, 1])
    assert correlation > 0.99, correlation


def test_store_rejects_non_string_paths() -> None:
    with pytest.raises(tasks.TaskError) as caught:
        tasks.WhisperStore()._load("transcribe", {"model.bin": 5})
    assert caught.value.code == "bad-request"


def test_alignment_rejects_words_parked_at_the_end() -> None:
    data = {
        "segments": [
            {
                "words": [
                    {"word": "a", "start": 0.0, "end": 0.5, "probability": 0.9},
                    {"word": "b", "start": 0.5, "end": 1.0, "probability": 0.8},
                    {"word": "\u306e", "start": 1.0, "end": 1.0, "probability": 0.0},
                ]
            }
        ]
    }
    with pytest.raises(TaskError) as info:
        tasks._check_alignment(data)
    assert info.value.code == "align-failed"
    assert info.value.data["unplaced"] == 1


def test_alignment_ignores_zero_length_words_inside() -> None:
    data = {
        "segments": [
            {
                "words": [
                    {"word": "a", "start": 0.0, "end": 0.4, "probability": 0.9},
                    {"word": ",", "start": 0.4, "end": 0.4, "probability": 0.0},
                    {"word": "b", "start": 0.5, "end": 1.0, "probability": 0.8},
                ]
            }
        ]
    }
    tasks._check_alignment(data)


def test_large_v3_needs_preprocessor_config() -> None:
    root = Path("cache/temp/preprocessor-test")
    root.mkdir(parents=True, exist_ok=True)
    for name, payload in (
        ("model.bin", b"m"),
        ("tokenizer.json", b"t"),
        ("vocabulary.txt", b"v"),
        ("config.json", b'{"feature_size": 128}'),
    ):
        (root / name).write_bytes(payload)
    files = {
        name: str(root / name)
        for name in ("model.bin", "tokenizer.json", "vocabulary.txt", "config.json")
    }
    with pytest.raises(TaskError) as info:
        tasks._read_files(files)
    assert info.value.code == "model-file-missing"
    assert "preprocessor_config.json" in str(info.value.message)


def test_board_close_cancels_a_running_task() -> None:
    events: list[tuple[str, dict]] = []
    board = tasks.TaskBoard(lambda event, payload: events.append((event, payload)))
    started = threading.Event()

    def work(progress, cancel):
        started.set()
        while not cancel.is_set():
            time.sleep(0.01)
        raise tasks.TaskCancelled()

    board.start()
    submitted = board.submit("transcribe", work)
    assert started.wait(2.0)
    board.close(timeout_sec=2.0)
    assert not board._thread.is_alive()
    assert board.get(submitted["task_id"])["state"] == "cancelled"
