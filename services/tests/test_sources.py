"""Checks for ``services/felyrics/sources.py``.

The contract under test: reading samples ``[start, start + count)`` must equal
the same slice of one full sequential decode of that file, whatever order the
reads arrive in. Sequential reads exercise the cursor, out-of-order reads
exercise the preroll-and-discard path.

Run:
  python\\python.exe -m pytest services\\tests -q -p no:cacheprovider

The test media lives in ``cache/temp`` rather than a pytest ``tmp_path``: this
machine's sandbox refuses to list a directory that Python just created, so
``--basetemp`` cannot be used. Fixed paths also make failures reproducible.
"""

from __future__ import annotations

from pathlib import Path

import av
import numpy as np
import pytest
import soundfile as sf

from felyrics.sources import OUTPUT_RATE, Source, SourceError

REPO = Path(__file__).resolve().parents[2]
MEDIA = REPO / "cache" / "temp"
MP3 = REPO / "tests" / "song.mp3"

FIXTURE_SEC = 3.0
FIXTURE_RATE = 44100
FIXTURE = MEDIA / "pytest-fixture-44k.wav"
ATOL = 1e-6


def reference_48k(path: Path) -> np.ndarray:
    """One slow sequential decode of the whole file: the ground truth."""
    chunks: list[np.ndarray] = []
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=OUTPUT_RATE)
        for frame in container.decode(stream):
            chunks.extend(out.to_ndarray() for out in resampler.resample(frame))
        chunks.extend(out.to_ndarray() for out in resampler.resample(None))
    return np.concatenate(chunks, axis=1)


def assert_same(actual: np.ndarray, expected: np.ndarray, label: str) -> None:
    assert actual.shape == expected.shape, (
        f"{label}: shape {actual.shape} != expected {expected.shape}"
    )
    if actual.size == 0:
        return
    diff = float(np.abs(actual - expected).max())
    assert diff <= ATOL, f"{label}: max |diff| = {diff:.3e} (limit {ATOL:.0e})"


def sec(value: float) -> int:
    return int(round(value * OUTPUT_RATE))


@pytest.fixture(scope="module")
def wav() -> Path:
    """44.1 kHz stereo wav, so the resampler is really doing its job."""
    MEDIA.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20260918)
    n = int(FIXTURE_SEC * FIXTURE_RATE)
    data = (rng.standard_normal((n, 2)) * 0.1).astype(np.float32)
    sf.write(str(FIXTURE), data, FIXTURE_RATE, subtype="FLOAT")
    return FIXTURE


@pytest.fixture(scope="module")
def wav_truth(wav: Path) -> np.ndarray:
    return reference_48k(wav)


def test_sequential_reads_are_exact(wav: Path, wav_truth: np.ndarray) -> None:
    source = Source.open(wav)
    try:
        step = sec(0.1)
        pieces = [source.read(i * step, step) for i in range(15)]
    finally:
        source.close()
    got = np.concatenate(pieces, axis=1)
    assert_same(got, wav_truth[:, : got.shape[1]], "sequential 0.1 s reads")


def test_random_access_is_exact(wav: Path, wav_truth: np.ndarray) -> None:
    source = Source.open(wav)
    count = sec(0.2)
    try:
        for start_sec in (1.5, 0.4, 2.6, 1.2, 2.9, 0.0):
            start = sec(start_sec)
            got = source.read(start, count)
            assert_same(
                got, wav_truth[:, start : start + count], f"read at {start_sec}s"
            )
    finally:
        source.close()


def test_forward_continuation_matches_single_read(
    wav: Path, wav_truth: np.ndarray
) -> None:
    """Two halves read back to back must equal one read of the whole range."""
    start, count = sec(1.0), sec(0.5)
    source = Source.open(wav)
    try:
        first = source.read(start, count // 2)
        second = source.read(start + count // 2, count - count // 2)
    finally:
        source.close()
    got = np.concatenate([first, second], axis=1)
    assert_same(got, wav_truth[:, start : start + count], "split read")


def test_short_read_at_end(wav: Path, wav_truth: np.ndarray) -> None:
    source = Source.open(wav)
    total = source.total_samples
    start = total - sec(0.05)
    try:
        got = source.read(start, sec(1.0))
    finally:
        source.close()
    assert 0 < got.shape[1] < sec(1.0), f"expected a short tail, got {got.shape[1]}"
    assert_same(got, wav_truth[:, start : start + got.shape[1]], "tail read")


def test_negative_start_is_rejected(wav: Path) -> None:
    source = Source.open(wav)
    try:
        with pytest.raises(SourceError) as info:
            source.read(-1, sec(0.1))
    finally:
        source.close()
    assert info.value.code == "range-out-of-bounds"


def test_missing_file_reports_source_not_found() -> None:
    with pytest.raises(SourceError) as info:
        Source.open(MEDIA / "definitely-missing.mp3")
    assert info.value.code == "source-not-found"


