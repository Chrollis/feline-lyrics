"""Checks for ``services/felyrics/server.py`` and ``__main__.py``.

Drives a real service over loopback with the sync websocket client:
handshake, token rejection, media ranges (FLAC 24 round trip against one full
decode), protocol errors, and process-level shutdown.

Run:
  python\\python.exe -m pytest services\\tests -q -p no:cacheprovider
"""

from __future__ import annotations

import asyncio
import io
import json
import threading
from pathlib import Path

import av
import numpy as np
import pytest
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from felyrics import espeak, sources
from felyrics.server import MAX_PAYLOAD_BYTES, BackendService, encode_flac, run_service

REPO = Path(__file__).resolve().parents[2]
MEDIA = REPO / "cache" / "temp"
MP3 = REPO / "tests" / "song.mp3"
FIXTURE = MEDIA / "pytest-fixture-44k.wav"
TOKEN = "test-token"
ATOL = 1e-6


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

    def url(self, token: str = TOKEN) -> str:
        return f"ws://127.0.0.1:{self.port}/?token={token}"

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
def ws(server: ServerThread):
    with connect(server.url(), proxy=None) as socket:
        yield socket


def send(socket, payload: dict) -> None:
    socket.send(json.dumps(payload))


def recv(socket) -> dict:
    return json.loads(socket.recv())


def request(socket, msg_id: str, method: str, params: dict | None = None) -> dict:
    send(socket, {"v": 1, "id": msg_id, "method": method, "params": params or {}})
    return recv(socket)


def hello(socket) -> dict:
    reply = request(socket, "hello", "hello", {"client": "pytest", "protocol": 1})
    assert reply["ok"] is True, reply
    return reply["result"]


def frames_until_last(socket, req_id: str) -> list[dict]:
    frames = []
    while True:
        raw = socket.recv()
        assert isinstance(raw, bytes), f"expected a binary frame, got {raw!r}"
        header_len = int.from_bytes(raw[:4], "little")
        header = json.loads(raw[4 : 4 + header_len])
        payload = raw[4 + header_len :]
        assert header["req_id"] == req_id
        frames.append({"header": header, "payload": payload})
        if header["last"]:
            return frames


def decode_flac(payload: bytes) -> np.ndarray:
    with av.open(io.BytesIO(payload)) as container:
        stream = container.streams.audio[0]
        data = np.concatenate(
            [frame.to_ndarray().reshape(-1) for frame in container.decode(stream)]
        ).astype(np.int64)
    pcm = (data >> 8).astype(np.float32) / np.float32(2**23)
    return pcm.reshape(-1, 2).T


def reference(path: Path) -> np.ndarray:
    source = sources.Source.open(path)
    try:
        return source.read(0, source.total_samples)
    finally:
        source.close()


# -- handshake and transport ------------------------------------------------


def test_hello_announces_formats(ws) -> None:
    result = hello(ws)
    assert result["protocol"] == 1
    assert result["audio"] == {"codec": "flac", "rate": 48000, "channels": 2, "bits": 24}
    assert result["video"]["codec"] == "png"
    assert result["video"]["scales"] == [1, 0.5, 0.3333, 0.25]
    assert result["video"]["fps"] == [24, 30, 60]
    assert result["max_payload_bytes"] == 8388608
    assert result["limits"] == {"max_range_seconds": 10, "max_open_sources": 8}
    ipa = result["ipa"]
    assert isinstance(ipa["available"], bool)
    assert (ipa["available"] and ipa["languages"]) or not ipa["languages"]


def test_bad_token_is_rejected(server: ServerThread) -> None:
    with connect(server.url(token="wrong"), proxy=None) as socket:
        with pytest.raises(ConnectionClosed) as excinfo:
            socket.recv()
    assert excinfo.value.rcvd is not None
    assert excinfo.value.rcvd.code == 4401


def test_hello_required_before_other_methods(ws) -> None:
    reply = request(ws, "1", "open_source", {"path": str(MP3)})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "hello-required"


def test_protocol_mismatch(ws) -> None:
    send(ws, {"v": 2, "id": "1", "method": "hello", "params": {}})
    reply = recv(ws)
    assert reply["error"]["code"] == "protocol-mismatch"


def test_malformed_json_is_reported(ws) -> None:
    hello(ws)
    ws.send("{not json")
    reply = recv(ws)
    assert reply["error"]["code"] == "bad-request"
    assert reply["id"] is None


def test_unknown_method(ws) -> None:
    hello(ws)
    send(ws, {"v": 1, "id": "1", "method": "nope", "params": {}})
    reply = recv(ws)
    assert reply["error"]["code"] == "bad-request"


def test_unimplemented_methods_are_reported(ws) -> None:
    hello(ws)
    reply = request(ws, "1", "task.submit", {"kind": "transcribe"})
    assert reply["error"]["code"] == "bad-request"
    assert "params must be an object" in reply["error"]["message"]


# -- media ------------------------------------------------------------------


def test_open_source_streams(ws) -> None:
    hello(ws)
    reply = request(ws, "1", "open_source", {"path": str(MP3)})
    assert reply["ok"] is True, reply
    result = reply["result"]
    assert Path(result["path"]) == MP3
    assert result["duration_sec"] == pytest.approx(215.048375, abs=1e-6)
    (audio,) = result["streams"]
    assert audio["index"] == 0 and audio["kind"] == "audio"
    assert audio["sample_rate"] == 48000 and audio["channels"] == 2
    assert audio["total_samples"] == 10322322
    closed = request(ws, "2", "close_source", {"source_id": result["source_id"]})
    assert closed["ok"] is True


def test_open_source_missing_file(ws) -> None:
    hello(ws)
    reply = request(ws, "1", "open_source", {"path": str(MEDIA / "nope.mp3")})
    assert reply["error"]["code"] == "source-not-found"


def test_audio_range_round_trip(ws) -> None:
    hello(ws)
    opened = request(ws, "1", "open_source", {"path": str(MP3)})["result"]
    source_id = opened["source_id"]

    send(
        ws,
        {
            "v": 1,
            "id": "2",
            "method": "request_range",
            "params": {
                "source_id": source_id,
                "kind": "audio",
                "stream": 0,
                "start_sec": 1.0,
                "duration_sec": 0.5,
            },
        },
    )
    ack = recv(ws)
    assert ack["ok"] is True, ack
    result = ack["result"]
    assert result["start_sample"] == 48000
    assert result["count"] == 24000
    assert result["bytes"] > 0
    assert result["packets"] == 1

    frames = frames_until_last(ws, "2")
    assert len(frames) == 1
    assert frames[0]["header"]["codec"] == "flac"
    assert len(frames[0]["payload"]) == result["bytes"]

    pcm = decode_flac(frames[0]["payload"])
    expected = reference(MP3)[:, 48000 : 48000 + 24000]
    assert pcm.shape == (2, 24000)
    diff = float(np.abs(pcm - expected).max())
    assert diff <= ATOL, f"max |diff| = {diff:.3e}"


def test_range_clamped_past_end_is_one_terminal_frame(ws) -> None:
    hello(ws)
    opened = request(ws, "1", "open_source", {"path": str(MP3)})["result"]
    send(
        ws,
        {
            "v": 1,
            "id": "2",
            "method": "request_range",
            "params": {
                "source_id": opened["source_id"],
                "start_sec": 300.0,
                "duration_sec": 1.0,
            },
        },
    )
    ack = recv(ws)["result"]
    assert ack["start_sample"] == 10322322
    assert ack["count"] == 0
    assert ack["bytes"] == 0
    frames = frames_until_last(ws, "2")
    assert len(frames) == 1
    assert frames[0]["header"]["last"] is True
    assert frames[0]["payload"] == b""


def test_range_bounds_errors(ws) -> None:
    hello(ws)
    opened = request(ws, "1", "open_source", {"path": str(MP3)})["result"]
    source_id = opened["source_id"]
    base = {"source_id": source_id, "kind": "audio"}
    cases = [
        ({"start_sec": -1.0, "duration_sec": 1.0}, "range-out-of-bounds"),
        ({"start_sec": 0.0, "duration_sec": 0.0}, "bad-request"),
        ({"start_sec": 0.0, "duration_sec": 11.0}, "range-too-large"),
        ({"start_sec": "x", "duration_sec": 1.0}, "bad-request"),
    ]
    for index, (params, code) in enumerate(cases):
        reply = request(ws, f"r{index}", "request_range", {**base, **params})
        assert reply["error"]["code"] == code, reply


def test_range_unknown_source(ws) -> None:
    hello(ws)
    reply = request(
        ws,
        "1",
        "request_range",
        {"source_id": "nope", "start_sec": 0.0, "duration_sec": 1.0},
    )
    assert reply["error"]["code"] == "source-not-found"


def test_encode_flac_is_24_bit_and_exact() -> None:
    rng = np.random.default_rng(7)
    pcm = rng.uniform(-0.5, 0.5, size=(2, 4800)).astype(np.float32)
    payload = encode_flac(pcm)
    with av.open(io.BytesIO(payload)) as container:
        stream = container.streams.audio[0]
        bits = getattr(stream.codec_context, "bits_per_raw_sample", 0)
        if bits:
            assert bits == 24
        back = np.concatenate(
            [frame.to_ndarray().reshape(-1) for frame in container.decode(stream)]
        ).astype(np.int64)
    pcm_back = (back >> 8).astype(np.float32) / np.float32(2**23)
    assert np.abs(pcm_back - pcm.T.reshape(-1)).max() <= 2**-24


VIDEO = MEDIA / "pytest-fixture-video.mp4"


def ensure_video() -> Path:
    """A 2 s 320x240 30 fps mp4 with a deterministic moving box."""
    if VIDEO.is_file():
        return VIDEO
    width, height = 320, 240
    base = np.zeros((height, width, 3), np.uint8)
    base[..., 0] = np.linspace(0, 255, width, dtype=np.uint8)[None, :]
    base[..., 1] = np.linspace(0, 255, height, dtype=np.uint8)[:, None]
    base[..., 2] = 80
    MEDIA.mkdir(parents=True, exist_ok=True)
    with av.open(str(VIDEO), "w", format="mp4") as container:
        stream = container.add_stream("mpeg4", rate=30)
        stream.width, stream.height = width, height
        stream.pix_fmt = "yuv420p"
        for index in range(60):
            image = base.copy()
            image[80:160, 20 + index * 3 : 60 + index * 3] = (255, 0, 0)
            frame = av.VideoFrame.from_ndarray(image, format="rgb24")
            frame.pts = index
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    return VIDEO


def decode_video_frames(path: Path) -> list[tuple[float, np.ndarray]]:
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        out = []
        for frame in container.decode(stream):
            rgb = frame.reformat(width=320, height=240, format="rgb24")
            out.append((float(frame.pts * frame.time_base), rgb.to_ndarray(format="rgb24")))
    return out


def decode_png(payload: bytes) -> np.ndarray:
    with av.open(io.BytesIO(payload)) as container:
        frame = next(container.decode(container.streams.video[0]))
        return frame.reformat(format="rgb24").to_ndarray(format="rgb24")


def video_frames(socket, req_id: str) -> list[dict]:
    return frames_until_last(socket, req_id)


def test_open_source_video_streams(ws) -> None:
    hello(ws)
    reply = request(ws, "1", "open_source", {"path": str(ensure_video())})
    assert reply["ok"] is True, reply
    result = reply["result"]
    assert result["duration_sec"] == pytest.approx(2.0, abs=0.1)
    (video,) = result["streams"]
    assert video["index"] == 1 and video["kind"] == "video"
    assert video["codec"] == "mpeg4"
    assert video["width"] == 320 and video["height"] == 240
    assert video["fps"] == pytest.approx(30.0, abs=0.01)


def test_video_range_hold_last_matches_decoded_frames(ws) -> None:
    hello(ws)
    path = ensure_video()
    opened = request(ws, "1", "open_source", {"path": str(path)})["result"]
    send(
        ws,
        {
            "v": 1,
            "id": "2",
            "method": "request_range",
            "params": {
                "source_id": opened["source_id"],
                "kind": "video",
                "stream": 1,
                "start_sec": 0.2,
                "duration_sec": 1.0,
                "scale": 1,
                "fps": 30,
            },
        },
    )
    ack = recv(ws)["result"]
    assert ack["start_pts_us"] == 200000
    assert ack["count"] == 30
    frames = video_frames(ws, "2")
    assert len(frames) == 30

    reference = decode_video_frames(path)
    for slot, frame in enumerate(frames):
        header = frame["header"]
        assert header["codec"] == "png"
        assert header["width"] == 320 and header["height"] == 240
        target = 0.2 + slot / 30
        picked = None
        for pts, rgb in reference:
            if pts <= target + 1e-6:
                picked = rgb
            else:
                break
        assert picked is not None
        assert np.array_equal(decode_png(frame["payload"]), picked), f"slot {slot}"


def test_video_range_scale_and_fps(ws) -> None:
    hello(ws)
    opened = request(ws, "1", "open_source", {"path": str(ensure_video())})["result"]
    send(
        ws,
        {
            "v": 1,
            "id": "2",
            "method": "request_range",
            "params": {
                "source_id": opened["source_id"],
                "kind": "video",
                "start_sec": 0.0,
                "duration_sec": 0.5,
                "scale": 0.5,
                "fps": 60,
            },
        },
    )
    ack = recv(ws)["result"]
    assert ack["count"] == 30
    frames = video_frames(ws, "2")
    assert len(frames) == 30
    indexes = [frame["header"]["frame_index"] for frame in frames]
    assert indexes == [index // 2 for index in range(30)]
    for frame in frames:
        assert frame["header"]["width"] == 160
        assert frame["header"]["height"] == 120


def test_video_range_errors(ws) -> None:
    hello(ws)
    opened = request(ws, "1", "open_source", {"path": str(ensure_video())})["result"]
    base = {"source_id": opened["source_id"], "kind": "video", "start_sec": 0.0,
            "duration_sec": 0.5}
    cases = [
        ({"scale": 0.7}, "bad-request"),
        ({"fps": 25}, "bad-request"),
        ({"stream": 0}, "bad-request"),
        ({"kind": "audio", "stream": 0, "scale": None}, "source-unsupported-media"),
    ]
    for index, (extra, code) in enumerate(cases):
        reply = request(ws, f"v{index}", "request_range", {**base, **extra})
        assert reply["error"]["code"] == code, reply


def test_video_kind_on_audio_only_source(ws) -> None:
    hello(ws)
    opened = request(ws, "1", "open_source", {"path": str(MP3)})["result"]
    reply = request(
        ws,
        "2",
        "request_range",
        {"source_id": opened["source_id"], "kind": "video", "start_sec": 0.0,
         "duration_sec": 0.5},
    )
    assert reply["error"]["code"] == "source-unsupported-media"


def test_shutdown_stops_the_service() -> None:
    thread = ServerThread()
    with connect(thread.url(), proxy=None) as socket:
        hello(socket)
        reply = request(socket, "1", "shutdown")
        assert reply["ok"] is True
    thread.thread.join(10)
    assert not thread.thread.is_alive()


# -- annotate ---------------------------------------------------------------


def annotate(ws, msg_id: str, text: str, language: str, target: str) -> dict:
    reply = request(
        ws,
        msg_id,
        "annotate",
        {"text": text, "language": language, "target": target},
    )
    assert reply["ok"] is True, reply
    return reply["result"]


def test_annotate_zh_pinyin(ws) -> None:
    hello(ws)
    result = annotate(ws, "a1", "我爱北京", "zh", "pinyin")
    assert result["language"] == "zh"
    assert result["target"] == "pinyin"
    assert [unit["text"] for unit in result["units"]] == ["我", "爱", "北", "京"]
    assert [unit["syllables"] for unit in result["units"]] == [
        ["wǒ"],
        ["ài"],
        ["běi"],
        ["jīng"],
    ]
    assert all(unit["category"] == "hanzi" for unit in result["units"])


def test_annotate_ja_hiragana_and_romaji(ws) -> None:
    hello(ws)
    result = annotate(ws, "a1", "思い出じゃない", "ja", "hiragana")
    assert [
        (unit["text"], unit["category"], unit["syllables"])
        for unit in result["units"]
    ] == [
        ("思", "kanji", ["お", "も"]),
        ("い", "hiragana", ["い"]),
        ("出", "kanji", ["で"]),
        ("じゃ", "hiragana", ["じゃ"]),
        ("な", "hiragana", ["な"]),
        ("い", "hiragana", ["い"]),
    ]
    romaji = annotate(ws, "a2", "思い出じゃない", "ja", "romaji")
    assert [unit["syllables"] for unit in romaji["units"]] == [
        ["o", "mo"],
        ["i"],
        ["de"],
        ["ja"],
        ["na"],
        ["i"],
    ]


def test_annotate_ko_hangul(ws) -> None:
    hello(ws)
    result = annotate(ws, "a1", "안녕 大韓", "ko", "hangul")
    assert [
        (unit["text"], unit["category"], unit["syllables"])
        for unit in result["units"]
    ] == [
        ("안", "hangul", ["안"]),
        ("녕", "hangul", ["녕"]),
        ("大", "hanja", ["대"]),
        ("韓", "hanja", ["한"]),
    ]


def test_annotate_western_latin(ws) -> None:
    hello(ws)
    result = annotate(ws, "a1", "Grüße", "de", "latin")
    assert result["units"] == [
        {"text": "Grüße", "category": "latin", "offset": 0, "syllables": ["Grusse"]}
    ]


def test_annotate_errors(ws) -> None:
    hello(ws)
    cases = [
        ({"language": "zh", "target": "pinyin"}, "bad-request"),
        ({"text": "东京", "language": "ja", "target": "pinyin"}, "unsupported-target"),
        ({"text": "hello", "language": "en", "target": "ipa"}, None),
        ({"text": "x", "language": "xx", "target": "latin"}, "unsupported-language"),
    ]
    for index, (params, code) in enumerate(cases):
        reply = request(ws, f"a{index}", "annotate", params)
        assert reply["ok"] is False, reply
        if code is None:
            assert reply["error"]["code"] in ("ipa-unavailable", "annotation-anchor-mismatch")
        else:
            assert reply["error"]["code"] == code, reply


def test_ipa_split_matches_spike_samples() -> None:
    cases = {
        ("bˈɪznəs", "en"): ["bˈɪz", "nəs"],
        ("sˈaɪəns", "en"): ["sˈaɪ", "əns"],
        ("naɪˈiːv", "en"): ["naɪ", "ˈiːv"],
        ("frˈɔøndʃaft", "de"): ["frˈɔønd", "ʃaft"],
        ("prʲivʲˈet", "ru"): ["prʲi", "vʲˈet"],
        ("bɔ̃ʒˈuʁ", "fr"): ["bɔ̃", "ʒˈuʁ"],
    }
    for (ipa, language), expected in cases.items():
        assert espeak.split_ipa(ipa, language) == expected

