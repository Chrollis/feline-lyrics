"""Real-model acceptance for transcribe and align (skipped by default).

Runs the shipped medium checkpoint over the first 12 s of tests/song.mp3,
first recognising the text, then aligning that text back onto the same range,
all through the websocket protocol.

Run:
  $env:FELYRICS_REAL = "1"
  python\\python.exe -s -m pytest services\\tests\\test_tasks_real.py -q -p no:cacheprovider
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from websockets.sync.client import connect

from felyrics.server import BackendService, run_service

REPO = Path(__file__).resolve().parents[2]
MP3 = REPO / "tests" / "song.mp3"
MODEL_DIR = REPO / "models" / "Systran" / "faster-whisper-medium"
TOKEN = "real-token"
RANGE = {"start_sec": 0.0, "end_sec": 12.0}

pytestmark = pytest.mark.skipif(
    not os.environ.get("FELYRICS_REAL"),
    reason="real-model acceptance; set FELYRICS_REAL=1",
)


def _files() -> dict[str, str]:
    return {
        "model.bin": str(MODEL_DIR / "model.bin"),
        "config.json": str(MODEL_DIR / "config.json"),
        "tokenizer.json": str(MODEL_DIR / "tokenizer.json"),
        "vocabulary.txt": str(MODEL_DIR / "vocabulary.txt"),
    }


@pytest.fixture()
def server():
    import asyncio
    import threading

    service = BackendService(token=TOKEN)
    loop = asyncio.new_event_loop()
    port: dict[str, int] = {}
    ready = threading.Event()

    def run() -> None:
        asyncio.set_event_loop(loop)

        async def main() -> None:
            server = await run_service(service, "127.0.0.1", 0)
            port["value"] = server.sockets[0].getsockname()[1]
            ready.set()
            await service.stopped.wait()
            await service.aclose()
            server.close()
            await server.wait_closed()

        try:
            loop.run_until_complete(main())
        finally:
            loop.close()

    thread = threading.Thread(target=run, name="service", daemon=True)
    thread.start()
    assert ready.wait(10)
    try:
        yield f"ws://127.0.0.1:{port['value']}/?token={TOKEN}"
    finally:
        loop.call_soon_threadsafe(service.stopped.set)
        thread.join(10)


def request(connection, msg_id: str, method: str, params: dict) -> dict:
    connection.send(json.dumps({"v": 1, "id": msg_id, "method": method, "params": params}))
    while True:
        message = json.loads(connection.recv(timeout=120.0))
        if message.get("type") == "event":
            continue
        return message


def event(connection, name: str, timeout: float = 120.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        message = json.loads(connection.recv(timeout=timeout))
        if message.get("type") == "event" and message.get("event") == name:
            return message
    raise AssertionError(f"no {name} event")


def test_real_transcribe_then_align(server: str) -> None:
    assert MODEL_DIR.is_dir(), f"missing checkpoint at {MODEL_DIR}"
    with connect(server, proxy=None) as connection:
        hello = request(connection, "0", "hello", {"protocol": 1})
        assert hello["ok"] is True, hello
        opened = request(connection, "1", "open_source", {"path": str(MP3)})
        source_id = opened["result"]["source_id"]

        started = time.monotonic()
        submitted = request(
            connection,
            "2",
            "task.submit",
            {
                "kind": "transcribe",
                "params": {
                    "source_id": source_id,
                    "files": _files(),
                    "language": "ja",
                    "target": "romaji",
                    "range": RANGE,
                },
            },
        )
        assert submitted["ok"] is True, submitted
        transcript = event(connection, "task.done")
        recognise_seconds = time.monotonic() - started
        result = transcript["data"]["result"]
        assert result["segments"], "no segments"
        text = result["text"]
        assert text.strip(), "no text"
        words = [word for segment in result["segments"] for word in segment["words"]]
        assert words, "no word timings"
        assert all(word["start"] <= word["end"] for word in words)
        assert any("syllables" in word for word in words), "no syllables attached"

        started = time.monotonic()
        submitted = request(
            connection,
            "3",
            "task.submit",
            {
                "kind": "align",
                "params": {
                    "source_id": source_id,
                    "files": _files(),
                    "language": "ja",
                    "target": "romaji",
                    "text": text,
                    "range": RANGE,
                },
            },
        )
        assert submitted["ok"] is True, submitted
        aligned = event(connection, "task.done")
        align_seconds = time.monotonic() - started
        result = aligned["data"]["result"]
        assert result["segments"], "alignment returned no segments"
        words = [word for segment in result["segments"] for word in segment["words"]]
        assert words and all(word["start"] <= word["end"] for word in words)

        print(
            f"\nreal model: '{text}' | segments={len(result['segments'])} "
            f"| recognise={recognise_seconds:.1f}s align={align_seconds:.1f}s"
        )


def test_real_missing_vocabulary_fails_the_task(server: str) -> None:
    with connect(server, proxy=None) as connection:
        request(connection, "0", "hello", {"protocol": 1})
        opened = request(connection, "1", "open_source", {"path": str(MP3)})
        source_id = opened["result"]["source_id"]
        files = _files()
        del files["vocabulary.txt"]
        submitted = request(
            connection,
            "2",
            "task.submit",
            {
                "kind": "transcribe",
                "params": {
                    "source_id": source_id,
                    "files": files,
                    "language": "ja",
                    "target": "romaji",
                    "range": RANGE,
                },
            },
        )
        assert submitted["ok"] is True, submitted
        failed = event(connection, "task.failed")
        assert failed["data"]["error"]["code"] == "model-file-missing"
