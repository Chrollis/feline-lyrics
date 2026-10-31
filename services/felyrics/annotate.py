"""Tokenizer and annotator (docs/.be/api.md section 9).

``annotate`` is a pure function: text in, units out. Every unit carries the
full annotation ``syllables`` array in the requested ``target``; the renderer
does all filtering. No model is loaded and no task is involved.

Languages: ``ja`` (fugashi + unidic-lite), ``zh`` (pypinyin), ``ko``
(kiwipiepy + hanja) and everything else through ``romanizer`` (``latin``) or
the espeak-ng subprocess (``ipa``).
"""

from __future__ import annotations

import logging
import unicodedata
from typing import Any

_log = logging.getLogger("felyrics.annotate")

KANJI_RANGES = ((0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0xF900, 0xFAFF))
KANJI_EXTRA = {0x3005, 0x3007, 0x30F5, 0x30F6}  # 々 〇 ヵ ヶ
HIRAGANA_RANGE = (0x3040, 0x309F)
KATAKANA_RANGE = (0x30A0, 0x30FF)
HANGUL_RANGE = (0xAC00, 0xD7A3)
HANGUL_JAMO = ((0x1100, 0x11FF), (0x3131, 0x318E))
SMALL_COMBINING = set("ゃゅょぁぃぅぇぉャュョァィゥェォ")
STANDALONE = {"っ", "ッ", "ー"}

WESTERN_IPA = {"en", "de", "fr", "ru", "es", "it", "pt"}
LANGUAGES = {"zh", "ja", "ko"} | WESTERN_IPA | {"uk", "bg", "sr", "cs", "nl", "pl"}

# hiragana mora -> romaji. The table is data, not logic; yoon pairs included.
_KANA_ROMAJI = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "を": "o", "ん": "n", "ゔ": "vu",
    "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o",
    "ゃ": "ya", "ゅ": "yu", "ょ": "yo", "っ": "", "ー": "",
    "きゃ": "kya", "きゅ": "kyu", "きょ": "kyo",
    "しゃ": "sha", "しゅ": "shu", "しょ": "sho",
    "ちゃ": "cha", "ちゅ": "chu", "ちょ": "cho",
    "にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
    "ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo",
    "みゃ": "mya", "みゅ": "myu", "みょ": "myo",
    "りゃ": "rya", "りゅ": "ryu", "りょ": "ryo",
    "ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
    "じゃ": "ja", "じゅ": "ju", "じょ": "jo",
    "びゃ": "bya", "びゅ": "byu", "びょ": "byo",
    "ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
    "ふぁ": "fa", "ふぃ": "fi", "ふぇ": "fe", "ふぉ": "fo",
    "てぃ": "ti", "でぃ": "di", "うぃ": "wi", "うぇ": "we", "うぉ": "wo",
}


class AnnotationError(Exception):
    """An ``annotate`` failure carrying a code from api.md section 12."""

    def __init__(self, code: str, message: str, data: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data: dict[str, Any] = dict(data) if data else {}


# -- character classes ------------------------------------------------------


def _cp(ch: str) -> int:
    return ord(ch)


def is_kanji(ch: str) -> bool:
    cp = ord(ch)
    if cp in KANJI_EXTRA:
        return True
    return any(lo <= cp <= hi for lo, hi in KANJI_RANGES)


def is_hiragana(ch: str) -> bool:
    return HIRAGANA_RANGE[0] <= ord(ch) <= HIRAGANA_RANGE[1]


def is_katakana(ch: str) -> bool:
    return KATAKANA_RANGE[0] <= ord(ch) <= KATAKANA_RANGE[1]


def is_hangul_syllable(ch: str) -> bool:
    return HANGUL_RANGE[0] <= ord(ch) <= HANGUL_RANGE[1]


def is_hangul_jamo(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in HANGUL_JAMO)


def is_digit(ch: str) -> bool:
    return unicodedata.category(ch).startswith("N")


def is_letter(ch: str) -> bool:
    return unicodedata.category(ch).startswith("L")


def to_hiragana(text: str) -> str:
    out = []
    for ch in text:
        cp = ord(ch)
        if 0x30A1 <= cp <= 0x30F6:
            out.append(chr(cp - 0x60))
        elif cp == 0x30FC:
            out.append("\u30fc")
        else:
            out.append(ch)
    return "".join(out)


def to_katakana(text: str) -> str:
    out = []
    for ch in text:
        cp = ord(ch)
        if 0x3041 <= cp <= 0x3096:
            out.append(chr(cp + 0x60))
        else:
            out.append(ch)
    return "".join(out)


def split_mora(text: str) -> list[str]:
    """Split kana (or a kana reading) into mora; small vowels join the previous."""
    mora: list[str] = []
    for ch in text:
        if ch in SMALL_COMBINING and mora:
            mora[-1] += ch
        else:
            mora.append(ch)
    return mora


def mora_romaji(moras: list[str]) -> list[str]:
    out: list[str] = []
    double = False
    for mora in moras:
        if mora in STANDALONE and mora != "ー":
            double = True
            out.append("")
            continue
        if mora == "ー":
            out.append("")
            continue
        roman = _KANA_ROMAJI.get(mora)
        if roman is None:
            folded = to_hiragana(mora)
            roman = _KANA_ROMAJI.get(folded, folded)
        if double:
            if roman and roman[0].isalpha() and roman[0] not in "aeiou":
                roman = roman[0] + roman
            double = False
        out.append(roman)
    return out


def _render_kana(moras: list[str], target: str) -> list[str]:
    if target == "hiragana":
        return [to_hiragana(mora) for mora in moras]
    if target == "katakana":
        return [to_katakana(mora) for mora in moras]
    if target == "romaji":
        return mora_romaji(moras)
    raise AnnotationError(
        "unsupported-target", f"target {target!r} is not valid for ja", {"target": target}
    )


# -- japanese ---------------------------------------------------------------

_TAGGER: Any = None


def _tagger() -> Any:
    global _TAGGER
    if _TAGGER is None:
        import fugashi
        import unidic_lite

        _TAGGER = fugashi.Tagger(f'-d "{unidic_lite.DICDIR}"')
    return _TAGGER


def _runs(surface: str) -> list[tuple[str, str, int]]:
    """Maximal runs of one class: [(kind, text, offset)]."""
    def kind_of(ch: str) -> str:
        if is_kanji(ch):
            return "kanji"
        if is_hiragana(ch) or is_katakana(ch):
            return "kana"
        if is_digit(ch):
            return "digit"
        if is_letter(ch):
            return "latin"
        return "symbol"

    runs: list[tuple[str, str, int]] = []
    for index, ch in enumerate(surface):
        kind = kind_of(ch)
        if runs and runs[-1][0] == kind:
            previous = runs[-1]
            runs[-1] = (kind, previous[1] + ch, previous[2])
        else:
            runs.append((kind, ch, index))
    return runs


def _ja_units(text: str, target: str) -> list[dict[str, Any]]:
    if target not in ("hiragana", "katakana", "romaji"):
        raise AnnotationError(
            "unsupported-target",
            f"target {target!r} is not valid for ja",
            {"target": target, "allowed": ["hiragana", "katakana", "romaji"]},
        )
    units: list[dict[str, Any]] = []
    offset = 0
    for word in _tagger()(text):
        surface = word.surface
        if not surface:
            continue
        feature = word.feature
        reading = getattr(feature, "kana", None) or ""
        reading = to_hiragana(reading)
        runs = _runs(surface)
        cursor = 0
        for position, (kind, run_text, start) in enumerate(runs):
            base = offset + start
            if kind == "kana":
                moras = split_mora(run_text)
                rendered = _render_kana(moras, target)
                mora_offset = 0
                for mora, syllable in zip(moras, rendered):
                    units.append(
                        {
                            "text": mora,
                            "category": "hiragana" if is_hiragana(mora[0]) else "katakana",
                            "offset": base + mora_offset,
                            "syllables": [syllable],
                        }
                    )
                    mora_offset += len(mora)
                if reading:
                    for char in to_hiragana(run_text):
                        found = reading.find(char, cursor)
                        if found < 0:
                            raise AnnotationError(
                                "annotation-anchor-mismatch",
                                f"surface kana {char!r} not found in reading {reading!r}",
                                {
                                    "items": [
                                        {
                                            "text": surface,
                                            "surface": char,
                                            "reading": reading,
                                            "index": cursor,
                                        }
                                    ]
                                },
                            )
                        cursor = found + 1
                continue
            if kind == "kanji":
                following = runs[position + 1] if position + 1 < len(runs) else None
                slice_text = ""
                if following is not None and following[0] == "kana" and reading:
                    anchor = to_hiragana(following[1][0])
                    found = reading.find(anchor, cursor)
                    if found < 0:
                        raise AnnotationError(
                            "annotation-anchor-mismatch",
                            f"surface kana {anchor!r} not found in reading {reading!r}",
                            {
                                "items": [
                                    {
                                        "text": surface,
                                        "surface": anchor,
                                        "reading": reading,
                                        "index": cursor,
                                    }
                                ]
                            },
                        )
                    slice_text = reading[cursor:found]
                    cursor = found
                elif reading:
                    slice_text = reading[cursor:]
                    cursor = len(reading)
                moras = split_mora(slice_text) if slice_text else [run_text]
                rendered = _render_kana(moras, target) if slice_text else [run_text]
                units.append(
                    {
                        "text": run_text,
                        "category": "kanji",
                        "offset": base,
                        "syllables": rendered,
                        "morpheme": {"tag": getattr(feature, "pos1", "")},
                    }
                )
                continue
            category = {"digit": "digit", "latin": "latin", "symbol": "symbol"}[kind]
            units.append(
                {"text": run_text, "category": category, "offset": base, "syllables": [run_text]}
            )
        offset += len(surface)
    return units


# -- chinese ----------------------------------------------------------------

_PINYIN_STYLE: Any = None


def _pinyin(ch: str) -> str:
    global _PINYIN_STYLE
    from pypinyin import Style, pinyin

    _PINYIN_STYLE = Style.TONE
    readings = pinyin(ch, style=Style.TONE, heteronym=False, neutral_tone_with_five=True)
    return readings[0][0] if readings and readings[0] else ch


def _zh_units(text: str, target: str) -> list[dict[str, Any]]:
    if target != "pinyin":
        raise AnnotationError(
            "unsupported-target",
            f"target {target!r} is not valid for zh",
            {"target": target, "allowed": ["pinyin"]},
        )
    units: list[dict[str, Any]] = []
    index = 0
    while index < len(text):
        ch = text[index]
        if ch.isspace():
            index += 1
            continue
        if is_kanji(ch):
            units.append(
                {"text": ch, "category": "hanzi", "offset": index, "syllables": [_pinyin(ch)]}
            )
            index += 1
            continue
        if is_digit(ch) or is_letter(ch):
            end = index
            while end < len(text) and (is_digit(text[end]) if is_digit(ch) else is_letter(text[end])):
                end += 1
            run = text[index:end]
            category = "digit" if is_digit(ch) else "latin"
            units.append({"text": run, "category": category, "offset": index, "syllables": [run]})
            index = end
            continue
        units.append({"text": ch, "category": "symbol", "offset": index, "syllables": [ch]})
        index += 1
    return units


# -- korean -----------------------------------------------------------------

_KIWI: Any = None


def _kiwi() -> Any:
    global _KIWI
    if _KIWI is None:
        from kiwipiepy import Kiwi

        _KIWI = Kiwi()
    return _KIWI


def _ko_units(text: str, target: str) -> list[dict[str, Any]]:
    if target not in ("hangul", "romaji"):
        raise AnnotationError(
            "unsupported-target",
            f"target {target!r} is not valid for ko",
            {"target": target, "allowed": ["hangul", "romaji"]},
        )
    import hanja
    from romanizer import Romanizer

    romanizer = Romanizer(mode="text")
    units: list[dict[str, Any]] = []
    for token in _kiwi().tokenize(text):
        form = token.form
        start_index = len(units)
        index = 0
        while index < len(form):
            ch = form[index]
            offset = token.start + index
            if is_hangul_syllable(ch):
                syllables = (
                    [ch] if target == "hangul" else [_romanize_ko(romanizer, ch)]
                )
                units.append(
                    {"text": ch, "category": "hangul", "offset": offset, "syllables": syllables}
                )
                index += 1
            elif is_hangul_jamo(ch):
                units.append(
                    {"text": ch, "category": "other", "offset": offset, "syllables": []}
                )
                index += 1
            elif is_kanji(ch):
                hangul = hanja.translate(ch, "substitution")
                syllables = (
                    [hangul]
                    if target == "hangul"
                    else [_romanize_ko(romanizer, hangul)]
                )
                units.append(
                    {"text": ch, "category": "hanja", "offset": offset, "syllables": syllables}
                )
                index += 1
            elif is_digit(ch):
                end = index
                while end < len(form) and is_digit(form[end]):
                    end += 1
                run = form[index:end]
                units.append(
                    {"text": run, "category": "digit", "offset": offset, "syllables": [run]}
                )
                index = end
            elif is_letter(ch):
                end = index
                while end < len(form) and is_letter(form[end]):
                    end += 1
                run = form[index:end]
                units.append(
                    {"text": run, "category": "latin", "offset": offset, "syllables": [run]}
                )
                index = end
            else:
                units.append(
                    {"text": ch, "category": "symbol", "offset": offset, "syllables": [ch]}
                )
                index += 1
        tag = getattr(token, "tag", None)
        if tag:
            # Keep the Kiwi morpheme so the editor can trace a unit back to
            # its token (api.md 9.6 morpheme field).
            morpheme = {"tag": str(tag), "lemma": getattr(token, "lemma", None) or form}
            for unit in units[start_index:]:
                unit["morpheme"] = morpheme
    return units


# -- western ----------------------------------------------------------------

_WESTERN: Any = None


def _romanizer() -> Any:
    global _WESTERN
    if _WESTERN is None:
        from romanizer import Romanizer

        _WESTERN = Romanizer(mode="text")
    return _WESTERN


def _romanize_ko(romanizer: Any, text: str) -> str:
    output = romanizer.romanize(text, "ko")
    if output == text and any(ord(ch) > 127 for ch in text):
        # romanizer has a single fallback policy: keep the surface and report
        # nothing. Log it so a silently untransliterated unit is traceable.
        _log.warning("romanizer kept the surface spelling of %r (ko)", text)
    return output


def _west_units(text: str, language: str, target: str) -> list[dict[str, Any]]:
    if target not in ("latin", "ipa"):
        raise AnnotationError(
            "unsupported-target",
            f"target {target!r} is not valid for {language}",
            {"target": target, "allowed": ["latin", "ipa"]},
        )
    if target == "ipa" and language not in WESTERN_IPA:
        raise AnnotationError(
            "ipa-unavailable",
            f"no syllable table for language {language!r}",
            {"language": language, "reason": "no-syllable-table"},
        )
    romanizer = _romanizer()
    words: list[tuple[int, int]] = []
    index = 0
    while index < len(text):
        ch = text[index]
        if ch.isspace():
            index += 1
            continue
        if is_letter(ch) or ch in "'\u2019":
            end = index
            while end < len(text) and (is_letter(text[end]) or text[end] in "'\u2019"):
                end += 1
            words.append((index, end))
            index = end
            continue
        index += 1
    # One espeak-ng subprocess per request, not one per word (api.md 10.2).
    phonemes: list[list[str]] = []
    if target == "ipa" and words:
        from . import espeak

        phonemes = espeak.syllables_batch(
            [text[start:end] for start, end in words], language
        )
    rendered: list[list[str]] = []
    if target == "latin":
        for start, end in words:
            word = text[start:end]
            try:
                output = romanizer.romanize(word, language)
            except Exception as exc:  # noqa: BLE001 - unsupported language
                raise AnnotationError(
                    "unsupported-language",
                    f"romanizer does not support {language!r}: {exc}",
                    {"language": language},
                ) from exc
            if output == word and any(ord(ch) > 127 for ch in word):
                _log.warning(
                    "romanizer kept the surface spelling of %r (%s)", word, language
                )
            # The syllable is the written word: romanizing again would drop
            # diacritics (schon/naive), which the doc forbids (api.md 10.1).
            rendered.append([word])
    units: list[dict[str, Any]] = []
    for position, (start, end) in enumerate(words):
        syllables = phonemes[position] if target == "ipa" else rendered[position]
        units.append(
            {
                "text": text[start:end],
                "category": "latin",
                "offset": start,
                "syllables": syllables,
            }
        )
    index = 0
    while index < len(text):
        ch = text[index]
        if ch.isspace():
            index += 1
            continue
        if is_letter(ch) or ch in "'\u2019":
            end = index
            while end < len(text) and (is_letter(text[end]) or text[end] in "'\u2019"):
                end += 1
            index = end
            continue
        if is_digit(ch):
            end = index
            while end < len(text) and is_digit(text[end]):
                end += 1
            run = text[index:end]
            units.append({"text": run, "category": "digit", "offset": index, "syllables": [run]})
            index = end
            continue
        units.append({"text": ch, "category": "symbol", "offset": index, "syllables": [ch]})
        index += 1
    units.sort(key=lambda unit: unit["offset"])
    return units


# -- entry point ------------------------------------------------------------


def _detect(text: str) -> str | None:
    if any(is_hiragana(ch) or is_katakana(ch) for ch in text):
        return "ja"
    if any(is_hangul_syllable(ch) or is_hangul_jamo(ch) for ch in text):
        return "ko"
    if any(is_kanji(ch) for ch in text):
        return "zh"
    return None


def annotate(
    text: str,
    language: str,
    target: str,
    espeak_dir: str | None = None,
) -> dict[str, Any]:
    """Tokenize ``text`` into units, each annotated in ``target``."""
    if not isinstance(text, str):
        raise AnnotationError("bad-request", "text must be a string")
    if not text:
        raise AnnotationError("bad-request", "text must not be empty")
    if not isinstance(language, str) or not language:
        raise AnnotationError("bad-request", "language must be a non-empty string")
    if not isinstance(target, str) or not target:
        raise AnnotationError("bad-request", "target must be a non-empty string")
    language = language.lower()
    if language not in LANGUAGES:
        raise AnnotationError(
            "unsupported-language", f"language {language!r} is not supported",
            {"language": language},
        )
    if espeak_dir is not None:
        from . import espeak

        espeak.configure(espeak_dir)

    if language == "ja":
        units = _ja_units(text, target)
    elif language == "zh":
        units = _zh_units(text, target)
    elif language == "ko":
        units = _ko_units(text, target)
    else:
        units = _west_units(text, language, target)

    detected = _detect(text)
    result: dict[str, Any] = {"language": language, "target": target, "units": units}
    if detected is not None and detected != language:
        result["suspected_language"] = detected
    return result
