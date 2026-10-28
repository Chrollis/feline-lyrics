# @felyrics/lyricore

The lyric model for Felyrics: plain data, pure functions, no rendering and no
timeline. A document is a list of lines; a line is a base character stream plus
named annotation runs; time lives on the cells and on the checks, nothing else.

Everything here is immutable: every edit returns a new value. An edit that would
change nothing returns the argument you passed in, so a caller can tell "no
change" by identity -- but only in the functions that take that fast path
(`withCheck`, `clearCheck`, `refillAll`). `withGroup` and `withPiece` always
rebuild, so do not compare by identity there.

## Requirements

- Node.js 22.18 or newer (the test suite runs the TypeScript sources directly).

## The model

```
Lyrics        { meta, lines[] }
LyricsLine    { baseStream, groups }
CharStream    { cells[] }               one cell per grapheme cluster
CharCell      { text, span }            span = { start, duration } | null
SegRun        { offset, length, pieces[] }
SegPiece      { check, text }           check = { time, type } | null
```

- `baseStream` always ends with exactly one line break cell.
- `groups` maps a name (`default`, `ruby`, ...) to a list of `SegRun`, sorted by
  offset and never overlapping. Every group ends with a **terminal run** that
  covers the line break cell.
- A run covers `[offset, offset + length)` base cells. Its `pieces` are the
  syllables of that annotation; the piece count is unrelated to `length`.
- Time is stored in two places only: `CharCell.span` and `SegPiece.check`.
  Everything else (line start, run start, piece start) is derived on demand.

`default` is the group the tag formats read and write: one run per tagged chunk,
empty pieces, the chunk time on the first piece's check.

## Build a document

```js
import { textToLyrics, lyricsToText, lyricsToJson, jsonToLyrics } from '@felyrics/lyricore';

const lyrics = textToLyrics('明日へ\n君と\n'); // untimed
lyricsToText(lyrics);                          // back to '明日へ\n君と\n'
jsonToLyrics(lyricsToJson(lyrics));            // the native file format
```

## Tag

Tapping records a check, and `recordCheck` derives the times behind it:

```js
import { recordCheck } from '@felyrics/lyricore';

const tapped = recordCheck(lyrics, { lineIndex: 0, group: 'default', runIndex: 0, pieceIndex: 0 },
    { time: 1000, type: 'KeyDown' });
```

The rules that fill the cells, in the order they were decided:

1. **Cell chain** — the cells of every run between the previous run's first
   check and this run's first check are split evenly.
2. **Piece chain** — the first characters of every piece between the previous
   check and this piece are split evenly.
3. **Terminal** — the terminal run's own cell starts at its check and lasts
   `TAIL_MS` (500 ms).
4. **Cross-line** — when a line's first cell is written, the previous line's
   terminal cell is rewritten as `[previous terminal check, this line's start)`.
5. **Sibling groups** — a changed cell range is pushed to the other groups of
   the same line, evenly across their runs.

Only a new check triggers this. Clearing a check, editing a span by hand, and
loading a file all leave the stored times alone.

## Edit structure

```js
import { splitLine, mergeLines, withPieceText, withGroup, editLineText } from '@felyrics/lyricore';
```

- `spliceLine` / `editLineText` insert or remove characters, and keep every run
  and piece anchored to the cells that survive.
- `splitLine` / `mergeLines` / `insertLine` / `removeLine` change the line list.
- `withPiece`, `withPieceText`, `withRun`, `withGroup` change annotation
  structure; `withMeta` changes metadata (an `undefined` field is left alone).

Every one of them validates what it touched and throws a `LyricoreError` with a
code instead of writing a shape the invariants reject.

## Import and export

```js
import { importTagText, exportTagText, importLrc, exportLrc, importPlainText, exportPlainText } from '@felyrics/lyricore';
```

Both directions return the document *and* the list of things the format could
not carry:

```js
const { lyrics, losses } = importTagText(text); // losses: { at, code, detail }[]
```

- **Tag text** (`.lrc` / `.kra` / `.txt`): timestamps before the text, a bare
  timestamp ends the line. Reads `[mm:ss]`, `[mm:ss:cc]`, `[mm:ss.cc]` (the
  number of fraction digits sets the unit), `[n|mm:ss:cc]` and `[n]` (check
  counts), `@Ruby=TT,RR[,t1][,t2]` (a reading for `TT` inside a time window),
  inline `{parent|reading}` with `＋` continuation, `$XXXX` escapes, and the
  `@Key=value` / `[key:value]` headers.
- **LRC**: one timestamp per line, so per-word times and annotations are
  reported as losses rather than silently collapsed.
- **Plain text**: text only; everything else is a loss.
- **Stanza breaks**: a blank line inside the lyric body is reported once per
  file (`n stanza break(s) dropped`). The separator this package writes before
  its own `@Ruby` block is structural and is not reported.
- **Encoding**: bytes are decoded by BOM first, then by strict UTF-8, then by
  scoring the candidates (Shift_JIS, EUC-JP, ISO-2022-JP, GB18030, Big5).
  UTF-16 is only reachable through a BOM: without one it cannot be told apart
  from the single-byte candidates. Writing supports UTF-8 and UTF-16LE only:
  Node ships no other encoder.
- A check `type` of `KeyUp` is read from `[10|...]` but never written; a
  document that carries one reports `dropped-check-kind` on export.

The RhythmicaLyrics-only additions (`[n|...]`, `{parent|reading}` with `＋`,
`$XXXX`, the `0x1A` placeholder column) are implemented from its source, not
from sample files: it keeps that shape in memory and writes none of it out, so
no exported sample exists to check them against. `@Ruby` and `[n|...]` are the
exceptions -- both are written back. The samples the tests run are
NicoKaraMaker3's `.lrc` files plus `reference/whisper/test/original.lrc`.

## Validate

`isValidLyrics` / `assertLyrics` check structure; a span outside the int32
millisecond range is a structure error. They do not check that timings are
consistent with each other. `isValidLyricsLine` and `assertLyricsLine` are the
per-line versions. A document that validates is not necessarily splittable —
splitting additionally needs the terminal runs the importer creates.

## Test

```
npm test --workspace @felyrics/lyricore
```
