"""espeak-ng integration for the ``ipa`` annotation target.

espeak-ng is GPL-3.0-or-later and is shipped as a separate executable, never
linked or bundled with this service (api.md section 5.1). The engine is called
once per ``annotate`` request, so each request is one subprocess.

The splitter is the one validated against espeak-ng in the design spike: greedy
left-to-right diphthong matching, stress marks attach to the following segment,
length/velarisation marks attach to the preceding one, and a single consonant
is always a legal onset while longer clusters take the longest legal suffix
from a per-language table.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Any

from .annotate import AnnotationError

IPA_LANGUAGES = ("en", "de", "fr", "ru", "es", "it", "pt")
DIACRITICS = "\u02d0\u02b0\u02b2\u02b7\u02e0\u02e1\u0303\u0329\u0330"
STRESS = "\u02c8\u02cc"

_VOWELS = set("aeiouyæɑɒɔəɚɛɜɪɨʊʌɤɯøœɵɐæɒɘɞɶ")
_DIPHTHONGS = {
    "en": ("aɪ", "aʊ", "eɪ", "oʊ", "ɔɪ", "ɑɪ", "əʊ"),
    "de": ("aɪ", "aʊ", "ɔʏ", "ɔø"),
    "fr": ("wa", "wɛ"),
    "ru": (),
    "es": (),
    "it": (),
    "pt": (),
}
_ONSETS = {
    "en": (
        "pr", "ple", "pl", "br", "bl", "tr", "dr", "kr", "kl", "gr", "gl",
        "fl", "fr", "θr", "ʃr", "sp", "st", "sk", "sm", "sn", "sl", "sw",
        "tw", "kw", "skr", "spr", "str", "spl", "skw",
    ),
    "de": ("pf", "ts", "tʃ", "pl", "pr", "bl", "br", "fl", "fr", "kl", "kn", "kr", "gl", "gr", "ʃp", "ʃt", "ʃl", "kn"),
    "fr": ("pl", "pr", "bl", "br", "fl", "fr", "kl", "kr", "gl", "gr", "tʁ", "dʁ", "vʁ", "pʁ"),
    "ru": ("pr", "br", "tr", "dr", "kr", "gr", "fr", "vr", "pl", "bl", "kl", "gl", "sl", "zl", "sm", "sn", "ʃt", "sp", "st", "str", "spr", "skr"),
    "es": ("pl", "pr", "bl", "br", "tr", "dr", "kl", "kr", "gl", "gr", "fl", "fr", "tʃ"),
    "it": ("pl", "pr", "bl", "br", "tr", "dr", "kl", "kr", "gl", "gr", "fl", "fr", "tʃ"),
    "pt": ("pl", "pr", "bl", "br", "tr", "dr", "kl", "kr", "gl", "gr", "fl", "fr"),
}

_EXE: str | None = None
_DIR: str | None = None


def configure(directory: str | None) -> None:
    """Record where the espeak-ng executable lives; ``None`` resets it."""
    global _EXE, _DIR
    _EXE = None
    _DIR = directory


def _find_exe() -> str | None:
    global _EXE
    if _EXE is not None:
        return _EXE
    names = ["espeak-ng.exe", "espeak-ng"] if os.name == "nt" else ["espeak-ng"]
    candidates: list[str] = []
    if _DIR:
        for name in names:
            candidates.append(os.path.join(_DIR, name))
    for name in names:
        found = shutil.which(name)
        if found:
            candidates.append(found)
    for candidate in candidates:
        if os.path.isfile(candidate):
            _EXE = candidate
            return candidate
    return None


def _find_data_dir(exe: str) -> str | None:
    """The engine cannot synthesise without its espeak-ng-data directory."""
    candidates: list[str] = []
    if _DIR:
        candidates.append(os.path.join(os.path.expanduser(_DIR), "espeak-ng-data"))
    candidates.append(os.path.join(os.path.dirname(exe), "espeak-ng-data"))
    for candidate in candidates:
        if os.path.isdir(candidate):
            return candidate
    return None


def available() -> bool:
    exe = _find_exe()
    return exe is not None and _find_data_dir(exe) is not None


def languages() -> list[str]:
    return list(IPA_LANGUAGES) if available() else []


def _require_exe(language: str) -> str:
    exe = _find_exe()
    if exe is None or _find_data_dir(exe) is None:
        raise AnnotationError(
            "ipa-unavailable",
            "espeak-ng or its data directory was not found",
            {"language": language, "reason": "engine-missing"},
        )
    return exe


def _engine(exe: str, text: str, language: str) -> str:
    try:
        completed = subprocess.run(
            [exe, "-q", "--ipa=txt", "-v", language],
            input=text,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired as exc:
        # TimeoutExpired is a SubprocessError, not an OSError: without this it
        # escapes the ipa-unavailable mapping and surfaces as internal-error.
        raise AnnotationError(
            "ipa-unavailable",
            "espeak-ng did not finish within 30 seconds",
            {"language": language, "reason": "timeout"},
        ) from exc
    except OSError as exc:
        raise AnnotationError(
            "ipa-unavailable",
            f"espeak-ng failed to start: {exc}",
            {"language": language, "reason": "engine-missing"},
        ) from exc
    return completed.stdout


def syllables(word: str, language: str) -> list[str]:
    """Return the IPA syllables of one western word."""
    exe = _require_exe(language)
    ipa = _engine(exe, word + "\n", language).strip()
    if not ipa:
        raise AnnotationError(
            "ipa-unavailable",
            f"espeak-ng produced no phonemes for {word!r}",
            {"language": language, "reason": "empty-phonemes"},
        )
    return split_ipa(ipa, language)


def syllables_batch(words: list[str], language: str) -> list[list[str]]:
    """Phonemise many words in one engine call (one subprocess per request).

    espeak-ng prints one IPA line per input line. If the line count ever
    disagrees, fall back to the per-word path so a result never desynchronises.
    """
    if not words:
        return []
    exe = _require_exe(language)
    lines = [line for line in _engine(exe, "\n".join(words) + "\n", language).splitlines() if line.strip()]
    if len(lines) == len(words):
        return [split_ipa(line.strip(), language) for line in lines]
    return [syllables(word, language) for word in words]


def _segment(ipa: str) -> list[str]:
    """Group the IPA string into segments: bases plus attached diacritics."""
    segments: list[str] = []
    for ch in ipa:
        if ch.isspace():
            continue
        if ch in STRESS:
            segments.append(ch)
            continue
        if ch in DIACRITICS and segments and segments[-1] not in STRESS:
            segments[-1] += ch
            continue
        segments.append(ch)
    return segments


def _is_vowel(segment: str) -> bool:
    return bool(segment) and segment[0] in _VOWELS


def _split_boundary(cluster: list[str], language: str) -> int:
    """Number of cluster segments that belong to the next syllable's onset."""
    if not cluster:
        return 0
    stress = sum(1 for segment in cluster if segment in STRESS)
    consonants = [segment for segment in cluster if segment not in STRESS]
    if not consonants:
        return len(cluster)
    if len(consonants) == 1:
        return len(cluster)
    table = _ONSETS.get(language, ())
    for length in range(len(consonants), 0, -1):
        candidate = "".join(consonants[-length:])
        stripped = candidate.rstrip(DIACRITICS)
        if length == 1:
            return 1 + stress
        if candidate in table or stripped in table:
            return length + stress
    return 1 + stress


def _merge_diphthongs(segments: list[str], language: str) -> list[str]:
    table = _DIPHTHONGS.get(language, ())
    merged: list[str] = []
    index = 0
    while index < len(segments):
        segment = segments[index]
        if _is_vowel(segment):
            for pair in table:
                if index + 1 < len(segments):
                    combined = segment + segments[index + 1]
                    bare = combined.rstrip(DIACRITICS)
                    if bare == pair:
                        merged.append(combined)
                        index += 2
                        break
            else:
                merged.append(segment)
                index += 1
            continue
        merged.append(segment)
        index += 1
    return merged


def split_ipa(ipa: str, language: str) -> list[str]:
    """Split one IPA string into syllable strings."""
    segments = _segment(ipa)
    segments = _merge_diphthongs(segments, language)
    if not segments:
        return [ipa]
    vowel_indices = [i for i, seg in enumerate(segments) if _is_vowel(seg)]
    if not vowel_indices:
        return ["".join(segments)]
    boundaries = [0]
    for left, right in zip(vowel_indices, vowel_indices[1:]):
        cluster = segments[left + 1 : right]
        onset = _split_boundary(cluster, language)
        boundaries.append(right - onset)
    boundaries.append(len(segments))
    syllables = [
        "".join(segments[start:end]) for start, end in zip(boundaries, boundaries[1:])
    ]
    return [s for s in syllables if s]
