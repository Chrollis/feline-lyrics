# @felyrics/lyricore

The lyric model for Felyrics: plain data, pure functions, no rendering and no
timeline. A document is a list of lines; a line is a base character stream plus
named annotation runs; time lives on the cells and on the checks, plus the one
explicit span an inserted object may carry.

Everything here is immutable: every edit returns a new value. An edit that would
change nothing usually returns the argument you passed in, so a caller can often
tell "no change" by identity -- but the fast path is per function, not a promise,
so do not build a comparison on it. When a difference has to be detected, compare
the values.

## Requirements

- Node.js 22.18 or newer (the test suite runs the TypeScript sources directly).

## The model

```
Lyrics         { meta, lines[], styleBook, animations }
LyricsLine     { baseStream, groups, overlay }
CharStream     { cells[] }               one cell per grapheme cluster
CharCell       { text, span }            span = { start, duration } | null
SegRun         { offset, length, pieces[] }
SegPiece       { check, text }           check = { time, type } | null
StyleRun       { offset, length, styleId }
InsertedObject { id, kind, anchor, content, time? }
LineOverlay    { styles[], inserted[], blocks[], runStyles[], annotations[] }
```

- `baseStream` always ends with exactly one line break cell.
- `groups` maps a name (`default`, `ruby`, ...) to a list of `SegRun`, sorted by
  offset and never overlapping. Every group ends with a **terminal run** that
  covers the line break cell.
- A run covers `[offset, offset + length)` base cells. Its `pieces` are the
  syllables of that annotation; the piece count is unrelated to `length`.
- Time is stored on `CharCell.span` and on `SegPiece.check`, plus the optional
  `time` of an inserted object that pins its own span. Everything else (line
  start, run start, piece start, a marker's extent) is derived on demand.
- `overlay` is the covering layer: the styles and the inserted objects. It rides
  on the line so that every edit keeps it aligned, but the lyric rules never
  interpret it and the lyrics export does not carry it.
- Overlay coordinates index the body, which is the line without its break cell:
  `styles` cover `[offset, offset + length)` inside `0..cells.length - 1`, and an
  `inserted` anchor uses the same span. `anchor.length === 0` is a point.

`default` is the group the tag formats read and write: one run per tagged chunk,
empty pieces, the chunk time on the first piece's check.

## Build a document

```js
import { textToLyrics, lyricsToText, lyricsToExportJson, readExportJson } from '@felyrics/lyricore';

const lyrics = textToLyrics('明日へ\n君と\n'); // untimed
lyricsToText(lyrics);                         // back to '明日へ\n君と\n'
readExportJson(lyricsToExportJson(lyrics));   // the frozen lyrics export
```

## Tag

Tapping records a check, and the cells behind that check are derived from it. A
check has to land in a slot, so the document needs runs first: a tag import
makes one run per tagged chunk, while `textToLyrics` makes none and gives you
nothing to write into.

```js
import { importTagText, recordCheck, refillGroup } from '@felyrics/lyricore';

// The import timed every chunk already, so this replaces a check instead of
// adding one, and the cells keep their spans until the group is refilled.
const { lyrics } = importTagText('[00:01:00]明[00:03:00]日へ\n');
const retimed = recordCheck(lyrics, { lineIndex: 0, group: 'default', runIndex: 1, pieceIndex: 0 },
    { time: 2000, type: 'KeyDown' });
const refilled = refillGroup(retimed, 0, 'default'); // 明 1000-2000, then 日へ from 2000
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
- `withPiece`, `withPieceText`, `withRun`, `withGroup`, `spliceGroups` change
  annotation structure; `withMeta` changes metadata (an `undefined` field is left
  alone).

Every one of them validates what it touched and throws a `LyricoreError` with a
code instead of writing a shape the invariants reject.

## Style and inserted objects

```js
import { withOverlay, withStyle, withAnnotations, withBlocks, withRunStyles, resolveStyle } from '@felyrics/lyricore';

const painted = withOverlay(line, {
    styles: [{ offset: 0, length: 3, styleId: 'chorus' }],
    inserted: [],
    blocks: [],
    runStyles: [],
    annotations: [],
});
```

`withOverlay` takes the whole overlay, so all five arrays are named. Each space
also has a setter that takes only its own array - `withStyles`, `withInserted`,
`withBlocks`, `withRunStyles`, `withAnnotations` - and the two forms are the
same call; the array a setter does not name is kept as it was.

- `StyleRun` paints a span of the body with a style id. Runs are sorted and never
  overlap; the writer merges two adjacent runs that name the same id into one.
  Typing at the end of a painted run extends the paint; typing at its start does
  not.
- The three group-keyed spaces address what the cell space cannot: `runStyles`
  holds a point at one run's first cell (`{ group, offset, styleId }`) and follows
  that run through every edit; `annotations` paints cells of a run's own text
  (`{ group, runOffset, offset, length, styleId }`, counted in cells of that run's
  concatenated piece text) and is dropped when the run no longer covers them;
  `blocks` names the soft break that starts a display block (`{ from, styleId }`,
  `null` for the first block) and is dropped with the break. `withStyles`,
  `withInserted`, `withRunStyles`, `withAnnotations` and `withBlocks` replace one
  array each and keep the rest.
- Splitting a line keeps a run style on both halves of a run that straddles the
  cut, cuts annotations where the reading is cut, and gives the right line's first
  block a copy of the style that covers the cut. Merging shifts the tail's
  entries by the junction; a head run style that lands exactly on the junction is
  dropped, because after the merge a different run starts there.
- A style id is a name, not a description: the definition lives in
  `Lyrics.styleBook`, which inherits through `basedOn` and resolves with
  `resolveStyle`. A line may name a style the book does not define; that is a
  dangling reference for the renderer, not a reason to refuse the document.
  The book's own edges are checked, though: `withStyle` refuses a `basedOn`
  that names no definition, a style that inherits from itself, an edge that
  closes a cycle and a chain deeper than 32 links - `invalid-style-def` for the
  one definition, `invalid-style-book` for the chain - and `assertStyleBook`
  applies the same rules to a book built elsewhere. The project reader runs
  them again on load and reports a failure under `invalid-project-file`, like
  every other shape error.
- A definition also names its SPACE: `character` (the default - the base text and
  a run's reading), `run` (one run's layout) or `paragraph` (one display block's
  layout). A `basedOn` whose parent sits in another space is refused, because the
  two resolve through different coordinate systems; `styleSpace` reads the field
  and an absent one means `character`. Each overlay array has one error code -
  `invalid-cell-style`, `invalid-run-style`, `invalid-annotation-style`,
  `invalid-block-style` - and the code names the LAYER, so it covers both a
  malformed record in that array and a style used there whose definition belongs
  to another space; `styleUseProblem` reports the second case and `assertLyrics`
  throws it. A missing definition stays a dangling reference, not an error.
- A definition's `content` is typed by its space and closed: the keys are the
  ones the space has (`CONTENT_KEYS`), a key from another space is refused, and a
  value of the wrong shape stops the load with the leaf path. An absent field is
  inherited from `basedOn`; a present one replaces the inherited value WHOLE, so
  an object inside a content is a complete statement, never merged field by
  field. A field is "explicitly nothing" in one of two ways: `shadow: null`, or
  `outlines: []` for a list - `fill` is never null (use a transparent colour) and
  nothing inside an object is optional. `outlines` is a LIST of layers painted in
  array order, first entry outermost and the fill on top, because a wipe can point
  each layer at its own progress. `resolveStyle` resolves from the complete
  built-in default (`defaultContent`): 48 px, weight 400, white, no outlines, no
  shadow, and a `fill.active` without a wipe switches hard rather than sweeping. A
  colour is `#rrggbb` or `#rrggbbaa`; an `image` fill is refused, because the
  resource system does not exist yet.
- An `InsertedObject` anchors to a span of the body. A zero-width anchor is a
  point: a soft break that splits the line into display blocks without splitting
  the lyric. A width-bearing anchor binds the cells it covers and survives an
  edit by clamping to whatever is left of them.
- `content` is what the object carries: `{ type: 'text', lines, styleId? }`,
  `{ type: 'image', src, wipedSrc?, scale? }`, or `null` for an object that
  carries nothing of its own - a marker. `kind` is the renderer's word for it, and
  the type stays a plain string: this package reads `kind` only to check that a
  known name agrees with its content (`soft-break` has none, `text` carries text,
  `image` carries an image) and carries every other name as it is.
- `content: null` requires a zero-width anchor. An edit that deletes the cells
  under a marker drops it; an object with content clamps to the surviving cells
  and is never destroyed.
- `time` pins an explicit span. Without it the object lasts as long as the cells
  it covers.
- The overlay is **not** in the lyrics export: `lyricsToExport` writes the lyric
  only, and the round trip through it comes back with an empty overlay. Paint and
  inserted objects belong to the project file.
- The validators and the empty values are exported as well: `overlayOf(line)`
  reads the overlay back, `NO_OVERLAY` is the empty one, and
  `overlayProblem(overlay, context)` / `assertOverlay` answer "is this overlay
  still on its line". The content surface is `CONTENT_KEYS` / `contentKeys(space)`,
  `defaultContent(space)`, `mergeContent`, `contentProblem` / `isValidContent` /
  `assertContent`, `styleSpace` / `STYLE_SPACES` / `isStyleSpace`, and the types
  `Color`, `Fill`, `DualFill`, `Wipe`, `Outline`, `Shadow`, `FontFamilies`.

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
  reported as losses rather than silently collapsed. Export can also report
  `unsupported-construct` (the body carries a `[` the reader parses as a tag,
  or a `$XXXX` it decodes: LRC has no quoting), `time-truncated` (an end time
  that is not a whole centisecond), `collapsed-run` (an inner chunk starts
  after the line does) and `dropped-annotation` (a group other than the default
  one). A line reports each of these at most once, and `dropped-annotation`
  once per group name.
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
per-line versions. A document that validates can be split: validation already
requires the terminal run that splitting cuts around, and every importer makes
one.

## The project file

`.flrc` is one JSON document: the lyrics export, plus the layers that are not lyrics.

```js
import { lyricsToProjectJson, readProjectJson } from '@felyrics/lyricore';

const text = lyricsToProjectJson(lyrics); // write
const { lyrics: back, issues } = readProjectJson(text); // read
```

```json
{
    "format": "felyrics/lyrics-project",
    "version": 1,
    "lyrics": { "format": "felyrics/lyrics", "version": 1, "meta": {}, "lines": [] },
    "styleBook": { "defs": { "chorus": { "content": { "fill": { "normal": { "kind": "solid", "color": "#ffcc00" } } } } } },
    "animations": [{ "kind": "fade", "target": "line:0" }]
}
```

A document with painted lines also writes `overlay`, one entry per line, so two
lines with the first one painted look like
`"overlay": [{ "styles": [{ "offset": 0, "length": 3, "styleId": "chorus" }] }, {}]`.
An entry writes the five arrays in the order `styles`, `inserted`, `blocks`,
`runStyles`, `annotations`, each only when it is not empty:

```json
{
    "styles": [{ "offset": 0, "length": 3, "styleId": "chorus" }],
    "inserted": [{ "id": "m1", "kind": "soft-break", "anchor": [3, 0] }],
    "blocks": [{ "from": null, "styleId": "verse" }, { "from": "m1", "styleId": "chorus" }],
    "runStyles": [{ "group": "ruby", "offset": 0, "styleId": "reading" }],
    "annotations": [{ "group": "ruby", "runOffset": 0, "offset": 0, "length": 3, "styleId": "soft" }]
}
```

- `lyrics` is the shape `lyricsToExport` produces, and the same reader reads it.
  The project adds nothing to it: the style book, the overlay and the animation
  list are siblings of the lyric, never keys inside it.
- `overlay` holds one entry per line, in line order. An unstyled line is `{}`, so
  the array index is the line index.
- A SECTION is omitted when it is empty: `overlay` when there are no lines,
  `styleBook` when there are no definitions, `animations` when the list is empty.
  Inside a section, an empty value is omitted too: a definition with no parent
  writes no `basedOn`, one in the default `character` space writes no `space`,
  one with no content writes no `content`, an entry with no paint writes no
  `styles`, a marker with no content writes no `content`, and one without a
  pinned span writes no `time`.
- Reading is strict about keys. An unknown key in the lyrics block, in the style
  book or in an overlay entry is an error with a path, not a value silently
  dropped on the next save. A block entry must carry `from` (written as `null`
  for the first block, never omitted). Every rejection is a `LyricoreError` with
  code `invalid-project-file`.
- A style id a line uses but the book does not define is reported once per id in
  `issues` as `style-orphan` and kept; the document still loads.
- Writing is canonical: a document written twice produces the same bytes, and
  writing what was just read reproduces the file. Reading normalises as it goes -
  adjacent runs that name the same style are merged - so a hand-written file with
  two such runs comes back with one. Two documents that compare equal can still
  differ in bytes: group names come out in the order the record holds them.
- `version` is `1`. A file written by a newer version is refused. A migration
  table exists for the first version that needs one; it is empty today, so only
  version 1 is accepted.
- `animations` is opaque here. It is checked to be an array and re-emitted
  unchanged; the shape inside is the renderer's.

The module also exports the object forms, `lyricsToProject` and
`projectToLyrics`, `projectToJson`, the format id `PROJECT_FORMAT` and the
`PROJECT_VERSION`, plus the file-shape types (`ProjectFile`, `ProjectRead`,
`StyleRunFile`, `InsertedObjectFile`, `OverlayEntryFile`, ...).

## Test

```
npm test --workspace @felyrics/lyricore
```
