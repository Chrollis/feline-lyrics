import { textToStream } from '../lyrics/char.js';
import { refillGroup, TAIL_MS } from '../lyrics/interpolate.js';
import { TIME_MAX } from '../lyrics/time.js';
import { rebuild, textToLyricsLine, type LyricsLine } from '../lyrics/line.js';
import { emptyMeta } from '../lyrics/meta.js';
import { lyricsOf, type Lyrics } from '../lyrics/lyrics.js';
import type { SegRun } from '../lyrics/seg-run.js';
import { newLosses, type LossCollector } from './loss.js';
import type { Exported, Imported } from './plain.js';
import { formatHeaders, parseHeader, withHeader } from './headers.js';
import {
    applyRuby,
    formatRuby,
    parseRubyLine,
    splitReading,
    type RubyEntry,
} from './ruby.js';

/** How long a closing line is assumed to show when nothing dates its end. */
export const LAST_LINE_MS = 5_000;
import { formatTag, parseTagContent, scanTags } from './tags.js';
import { ensureTrailingBreak, splitLines } from './text.js';

/** The group a plain time-tagged file fills: one run per tagged chunk. */
export const DEFAULT_GROUP = 'default';

/** The group `@Ruby` lines fill. */
export const RUBY_GROUP = 'ruby';

export type { Exported, Imported };

export interface TagImportOptions {
    /** Group that receives one run per tagged chunk. */
    readonly group?: string;
}

export interface TagExportOptions {
    /** Group whose runs decide where the tags go. */
    readonly group?: string;
}

function emptyPiece(
    check: { time: number; type: 'KeyDown' | 'KeyUp' } | null,
): SegRun['pieces'][number] {
    return { check, text: textToStream('') };
}

/**
 * The pieces a chunk asks for. `[n|...]` says the column has n checks, so it
 * gets n pieces; only the first can carry the tag's time. A count of 10 is
 * RhythmicaLyrics spelling for "this check came from the key going up", so it
 * becomes one piece whose check is a key-up.
 */
const KEY_UP_CHECKS = 10;

function piecesOf(
    check: SegRun['pieces'][number]['check'],
    checks: number,
): SegRun['pieces'][number][] {
    if (checks === KEY_UP_CHECKS) {
        return [
            emptyPiece(
                check === null ? null : { time: check.time, type: 'KeyUp' },
            ),
        ];
    }
    const count = Math.max(1, checks);
    const pieces: SegRun['pieces'][number][] = [emptyPiece(check)];
    for (let index = 1; index < count; index += 1) {
        pieces.push(emptyPiece(null));
    }
    return pieces;
}

function terminalRun(
    check: SegRun['pieces'][number]['check'],
    cells: number,
): SegRun {
    return { offset: cells - 1, length: 1, pieces: [emptyPiece(check)] };
}
/** The first and last time a line's content runs carry. */
function runTimes(
    line: LyricsLine,
    group: string,
): { first: number | null; last: number | null } {
    const runs = line.groups[group] ?? [];
    const content = runs.filter(
        (run) => run.offset < line.baseStream.cells.length - 1,
    );
    return {
        first: content[0]?.pieces[0]?.check?.time ?? null,
        last: content.at(-1)?.pieces[0]?.check?.time ?? null,
    };
}

/** Dates the line's newline cell: a standard LRC line carries no trailing tag. */
function withTerminalCheck(
    line: LyricsLine,
    group: string,
    time: number,
): LyricsLine {
    const runs = line.groups[group];
    const last = runs?.[runs.length - 1];
    if (runs === undefined || last === undefined) {
        return line;
    }
    if (last.offset !== line.baseStream.cells.length - 1) {
        return line;
    }
    const piece = last.pieces[0];
    if (piece === undefined || piece.check !== null) {
        return line;
    }
    const dated: SegRun = {
        ...last,
        pieces: [{ ...piece, check: { time, type: 'KeyDown' } }],
    };
    return {
        ...line,
        groups: { ...line.groups, [group]: [...runs.slice(0, -1), dated] },
    };
}

/** One `{parent|reading}` span found in a line, with where it starts. */
interface InlineRuby {
    readonly char: number;
    readonly parent: string;
    readonly reading: string;
}

/**
 * Pulls `{parent|reading}` spans out of a line. The parent text stays in the
 * lyric (it is what gets sung); the reading becomes an annotation later.
 */
function extractInlineRuby(
    content: string,
    at: string,
    losses: LossCollector,
): {
    text: string;
    spans: InlineRuby[];
} {
    const spans: InlineRuby[] = [];
    let text = '';
    let index = 0;
    while (index < content.length) {
        const open = content.indexOf('{', index);
        const close = open === -1 ? -1 : content.indexOf('}', open + 1);
        if (open === -1 || close === -1) {
            text += content.slice(index);
            break;
        }
        const nested = content.indexOf('{', open + 1);
        if (nested !== -1 && nested < close) {
            // `{...}` is a delimiter pair with no escape and no nesting, so a
            // second `{` means this is not an annotation. Keep it as text; the
            // same rule then reads the same string the same way on the next
            // import, which is what makes the conversion idempotent.
            losses.add(
                at,
                'unsupported-construct',
                `the braces at column ${open} contain another "{", so this is not an annotation`,
            );
            text += content.slice(index, close + 1);
            index = close + 1;
            continue;
        }
        const inside = content.slice(open + 1, close);
        const bar = inside.indexOf('|');
        if (bar <= 0) {
            text += content.slice(index, close + 1);
            index = close + 1;
            continue;
        }
        text += content.slice(index, open);
        const parent = inside.slice(0, bar);
        spans.push({
            char: text.length,
            parent,
            reading: inside.slice(bar + 1),
        });
        text += parent;
        index = close + 1;
    }
    return { text, spans };
}

/**
 * Turns an offset in the raw line into an offset in what becomes the cells.
 * Every tag before it disappears, so it has to be discounted.
 */
function cellsCharOffset(content: string, char: number): number {
    let removed = 0;
    let index = 0;
    while (index < char) {
        const open = content.indexOf('[', index);
        if (open === -1 || open >= char) {
            break;
        }
        const close = content.indexOf(']', open);
        if (close === -1 || close >= char) {
            break;
        }
        if (parseTagContent(content.slice(open + 1, close)) !== null) {
            removed += close - open + 1;
        }
        index = close + 1;
    }
    return char - removed;
}

/** The cell a character offset falls in, or -1 when it is past the end. */ function cellAtChar(
    cells: readonly { readonly text: string }[],
    char: number,
): number {
    let seen = 0;
    for (const [index, cell] of cells.entries()) {
        seen += cell.text.length;
        if (char < seen) {
            return index;
        }
    }
    return -1;
}

/**
 * One line of a time-tagged file becomes one `LyricsLine`: the chunks give the
 * base cells, and every chunk that starts at a time becomes a run of the
 * default group whose first piece carries that time as a check.
 */
function lineFromChunks(
    content: string,
    breakText: string,
    at: string,
    group: string,
    losses: LossCollector,
): LyricsLine {
    // Readings come out first: a reading may itself contain `[mm:ss:cc]`, and
    // the tag scanner must not see those as timing for the lyric.
    const inline = extractInlineRuby(content, at, losses);
    const scanned = scanTags(inline.text, at);
    for (const loss of scanned.losses) {
        losses.add(loss.at, loss.code, loss.detail);
    }
    const spans: InlineRuby[] = inline.spans.map((span) => ({
        ...span,
        char: cellsCharOffset(inline.text, span.char),
    }));
    const clean = scanned.chunks;
    const line = textToLyricsLine(
        clean.map((chunk) => chunk.text).join('') + breakText,
    );
    const cells = line.baseStream.cells.length;
    const runs: SegRun[] = [];
    // The time each cell gets from the chunk that starts it; a reading's inline
    // offsets are relative to the start of its parent, which is one of these.
    const cellTimes: (number | null)[] = [];
    let offset = 0;
    for (const chunk of clean) {
        const width = [...textToStream(chunk.text).cells].length;
        for (let at = 0; at < width; at += 1) {
            cellTimes.push(at === 0 ? chunk.time : null);
        }
        if (chunk.time === null) {
            if (offset > 0 && width > 0) {
                losses.add(
                    at,
                    'collapsed-run',
                    `text at cell ${offset} carries no time`,
                );
            }
        } else if (width === 0) {
            losses.add(
                at,
                'collapsed-run',
                `a tag at ${chunk.time}ms has no text after it before the next tag`,
            );
        } else {
            runs.push({
                offset,
                length: width,
                pieces: piecesOf(
                    chunk.time === null
                        ? null
                        : { time: chunk.time, type: 'KeyDown' },
                    chunk.checks,
                ),
            });
        }
        offset += width;
    }
    if (scanned.end !== null) {
        runs.push(terminalRun({ time: scanned.end, type: 'KeyUp' }, cells));
    } else {
        runs.push(terminalRun(null, cells));
    }
    const rubies: SegRun[] = [];
    for (const [index, span] of spans.entries()) {
        const start = cellAtChar(line.baseStream.cells, span.char);
        const end = cellAtChar(
            line.baseStream.cells,
            span.char + span.parent.length,
        );
        if (start < 0 || end < 0 || end <= start) {
            losses.add(
                at,
                'collapsed-run',
                `{${span.parent}|${span.reading}} has no cells`,
            );
            continue;
        }
        const parent = cellTimes[start] ?? null;
        // A trailing `＋` says the reading does not stop in this column: the
        // ruby is drawn over the next column too (and chains further, see
        // `reference/RhythmicaLyrics/@RhythmicaLyrics.hsp:2902-2907`, where a
        // reading ending in `＋` grows the joined span by one column).
        const joined = [...span.reading].filter((char) => char === '＋').length;
        const chunks = splitReading(span.reading.replace(/＋/g, ''));
        // A continuation may not claim the first cell of the next annotation:
        // one cell cannot belong to two runs, and the next span is placed
        // there already. The newline is never part of an annotation either, so
        // a continuation stops one cell short of it.
        const cells = line.baseStream.cells;
        const lineEnd = cells.length - 1;
        // The first following annotation that really occupies a cell: one that
        // is dropped below as "has no cells" claims nothing and must not stop
        // a continuation here.
        const following = spans.slice(index + 1).find((later) => {
            const from = cellAtChar(cells, later.char);
            const to = cellAtChar(cells, later.char + later.parent.length);
            return from >= 0 && to > from;
        });
        const next =
            following === undefined ? -1 : cellAtChar(cells, following.char);
        const limit = next < 0 ? lineEnd : Math.min(lineEnd, next);
        const room = Math.max(0, limit - start);
        // Each `＋` adds one cell past the parent, so a two-cell parent with one
        // marker wants three cells - not the `joined + 1` a one-cell parent
        // happens to make right.
        const wanted = end - start + joined;
        const runLength = Math.max(end - start, Math.min(wanted, room));
        if (joined > 0 && runLength < wanted) {
            const missing = wanted - runLength;
            losses.add(
                at,
                'collapsed-run',
                `{${span.parent}|${span.reading}}: the continuation needs ${missing} more ${missing === 1 ? 'cell' : 'cells'}${next < 0 ? ' before the end of the line' : ' before the next annotation'}`,
            );
        }
        if (chunks.length > 1 && parent === null) {
            losses.add(
                at,
                'dropped-check-times',
                `{${span.parent}|${span.reading}}: the parent has no start time to offset the reading from`,
            );
        }
        const pieces: SegRun['pieces'][number][] = [];
        let time = parent;
        for (const chunk of chunks) {
            if (chunk.offset !== null) {
                time = parent === null ? null : parent + chunk.offset;
            }
            if (chunk.text === '') {
                continue;
            }
            pieces.push({
                check: time === null ? null : { time, type: 'KeyDown' },
                text: textToStream(chunk.text),
            });
        }
        rubies.push({
            offset: start,
            length: runLength,
            pieces:
                pieces.length === 0
                    ? [
                          {
                              check: null,
                              text: textToStream(
                                  span.reading.replace(/＋/g, ''),
                              ),
                          },
                      ]
                    : pieces,
        });
    }
    const groups: Record<string, readonly SegRun[]> =
        rubies.length === 0
            ? { [group]: runs }
            : {
                  [group]: runs,
                  [RUBY_GROUP]: [...rubies, terminalRun(null, cells)],
              };
    return rebuild(line, { groups });
}

/**
 * Reads a `.lrc` / time-tagged lyric file. Metadata lines are not consumed
 * here yet; every non-empty line contributes base text, and each tag becomes a
 * check that the model then fills with the same rules the editor uses.
 */
export function importTagText(
    text: string,
    options: TagImportOptions = {},
): Imported {
    const group = options.group ?? DEFAULT_GROUP;
    const losses = newLosses();
    const lines: LyricsLine[] = [];
    const blanks: number[] = [];
    let firstLyric = -1;
    let lastLyric = -1;
    const rubies: { source: string; entry: RubyEntry }[] = [];
    let meta = emptyMeta();
    for (const [index, raw] of splitLines(
        ensureTrailingBreak(text, 'file', losses),
    ).entries()) {
        const content = raw.content.replace(/^\uFEFF/, '');
        if (content.trim() === '') {
            // A blank line is a stanza break: layout, not lyric content. Which
            // of them are structural is decided once the whole file is read, so
            // that the exporter's own separator before the `@Ruby` block is not
            // reported as a loss.
            blanks.push(index);
            continue;
        }
        const ruby = parseRubyLine(content);
        if (ruby !== null) {
            rubies.push({ source: `source[${index}]`, entry: ruby });
            continue;
        }
        if (/^@?ruby\d*\s*=/i.test(content.trim())) {
            // Kept below as metadata rather than deleted: the line carries no
            // reading, but its bytes still round trip through `extra`.
            losses.add(
                `source[${index}]`,
                'unsupported-construct',
                `"${content.trim()}" has no "TT,RR" payload, so no reading was attached; the line was kept as metadata`,
            );
        }
        const header = parseHeader(content);
        if (header !== null) {
            meta = withHeader(meta, header, `source[${index}]`, losses);
            continue;
        }
        lastLyric = index;
        if (firstLyric < 0) {
            firstLyric = index;
        }
        lines.push(
            lineFromChunks(
                content,
                raw.break,
                `source[${index}]`,
                group,
                losses,
            ),
        );
    }
    let gaps = 0;
    for (const blank of blanks) {
        // A stanza break only exists between two lyric lines. A leading blank,
        // a trailing one, and the separator this package writes before its own
        // `@Ruby` block are all structural, not lost.
        if (blank > firstLyric && blank < lastLyric) {
            gaps += 1;
        }
    }
    if (gaps > 0) {
        // One report for the whole file: the count is the information a reader
        // needs, and one loss per stanza would drown the real ones.
        losses.add(
            'file',
            'source-ignored',
            `${gaps} stanza break(s) dropped; the model has no line gap`,
        );
    }
    for (let index = 0; index < lines.length; index += 1) {
        const next =
            lines
                .slice(index + 1)
                .map((line) => runTimes(line, group).first)
                .find((time) => time !== null) ?? null;
        const runStart = runTimes(lines[index]!, group).first;
        const own = runTimes(lines[index]!, group).last;
        // A last line has no successor to date it, and plain LRC has no syntax
        // for a line's own end either; five seconds is the convention callers
        // expect a closing line to hold the screen for. The fabricated tail must
        // stay inside the time model, so a file tagged near the int32 ceiling
        // cannot push a terminal check past it.
        const tail = next === null ? LAST_LINE_MS : TAIL_MS;
        const raw =
            next ?? (own === null ? null : Math.min(TIME_MAX, own + tail));
        // A line cannot end before it starts: clamp to the line's FIRST check,
        // which is what "its own start" means here.
        const end =
            raw === null || runStart === null ? raw : Math.max(raw, runStart);
        if (end !== null) {
            lines[index] = withTerminalCheck(lines[index]!, group, end);
        }
    }
    let lyrics: Lyrics = lyricsOf(meta, lines);
    for (let index = 0; index < lines.length; index += 1) {
        lyrics = refillGroup(lyrics, index, group);
    }
    if (rubies.length > 0) {
        // One call: a call per entry rebuilds the "already claimed" map, and two
        // @Ruby lines with the same parent would then claim one occurrence.
        lyrics = applyRuby(
            lyrics,
            rubies.map((ruby) => ruby.entry),
            RUBY_GROUP,
            (entry, index) =>
                rubyLossAt(lyrics, entry, rubies[index]?.source ?? 'ruby'),
            losses,
        );
    } // Readings carry their own checks now, so the annotated cells get their
    // times from the same rule the tagged cells use.
    for (let index = 0; index < lyrics.lines.length; index += 1) {
        if (Object.hasOwn(lyrics.lines[index].groups, RUBY_GROUP)) {
            lyrics = refillGroup(lyrics, index, RUBY_GROUP);
        }
    }
    for (const [index, line] of lyrics.lines.entries()) {
        // Ask the exporter's question: is any body cell timed? A leading
        // untimed chunk leaves cell 0 null while the rest of the line is fine,
        // and the terminal run's check is fabricated here rather than read from
        // the file, so it says nothing about whether the source tagged the line.
        const cells = line.baseStream.cells;
        const body = cells.slice(0, Math.max(0, cells.length - 1));
        const first = body.find((cell) => cell.span !== null);
        const runs = Object.hasOwn(line.groups, group)
            ? line.groups[group]
            : undefined;
        const tagged =
            runs !== undefined &&
            runs.some(
                (run) =>
                    run.offset + run.length < cells.length &&
                    run.pieces.some((piece) => piece.check !== null),
            );
        if (tagged && first === undefined) {
            losses.add(
                `lines[${index}]`,
                'source-ignored',
                'the line was tagged but no cell could be timed, so its text carries no start',
            );
        }
    }
    return { lyrics, losses: losses.losses };
}

/**
 * Where an `@Ruby` entry was supposed to land, for the loss that says it did
 * not. The model coordinate is the row whose cells hold the parent text; a
 * parent that appears in no row has no model home, so only the source line it
 * came from can name it.
 */
function rubyLossAt(lyrics: Lyrics, entry: RubyEntry, source: string): string {
    const width = textToStream(entry.parent).cells.length;
    if (width === 0) {
        return `${source}.ruby`;
    }
    for (const [index, line] of lyrics.lines.entries()) {
        const cells = line.baseStream.cells;
        for (let from = 0; from + width <= cells.length; from += 1) {
            const text = cells
                .slice(from, from + width)
                .map((cell) => cell.text)
                .join('');
            if (text === entry.parent) {
                return `lines[${index}].ruby`;
            }
        }
    }
    return `${source}.ruby`;
}

/**
 * The cells a `@Ruby` parent covers. A comma there would have to be dropped
 * from the parent field, so the body has to drop it too or the two stop
 * matching. A comma anywhere else is harmless and stays.
 */
function separatorsUnderRuby(line: LyricsLine): ReadonlySet<number> {
    const covered = new Set<number>();
    const runs = Object.hasOwn(line.groups, RUBY_GROUP)
        ? (line.groups[RUBY_GROUP] ?? [])
        : [];
    const limit = line.baseStream.cells.length - 1;
    for (const run of runs) {
        if (run.offset >= limit) {
            continue;
        }
        for (let at = run.offset; at < run.offset + run.length; at += 1) {
            covered.add(at);
        }
    }
    return covered;
}

/**
 * Writes body text so the scanner reads it back as text. A `[` starts a tag, a
 * `$` starts an escape and a `{` starts inline ruby, and none has a quoting
 * rule, so all three are written as the escape the scanner already understands.
 * `$` goes first: escaping the others first would make the `$` they introduce
 * start an escape of its own. U+001A is left alone: the reader refuses that
 * escape and reports the placeholder it drops on the next read.
 */
function escapeBody(text: string): string {
    return text
        .replace(/\$/g, '$0024')
        .replace(/\[/g, '$005B')
        .replace(/\{/g, '$007B');
}

/** Writes one line back out, tagging the start of every run of the group. */
function lineToText(
    line: LyricsLine,
    group: string,
    at: string,
    losses: LossCollector,
    covered: ReadonlySet<number>,
): string {
    const cells = line.baseStream.cells;
    const runs = Object.hasOwn(line.groups, group) ? line.groups[group] : [];
    const byOffset = new Map<number, SegRun>();
    for (const run of runs ?? []) {
        if (run.offset < cells.length - 1) {
            byOffset.set(run.offset, run);
        }
    }
    const startOf = (run: SegRun): number | null => {
        const check = run.pieces[0]?.check ?? null;
        if (check !== null) {
            return check.time;
        }
        const first = cells[run.offset];
        return first === undefined || first.span === null
            ? null
            : first.span.start;
    };
    let out = '';
    const tag = (time: number): string => {
        if (time % 10 !== 0) {
            losses.add(
                at,
                'time-truncated',
                `${time} ms written as ${Math.floor(time / 10) * 10} ms: the format counts whole centiseconds, so ${time % 10} ms was lost`,
            );
        }
        return formatTag(time);
    };
    for (let offset = 0; offset < cells.length - 1; offset += 1) {
        const run = byOffset.get(offset);
        if (run !== undefined) {
            const start = startOf(run);
            if (start === null) {
                losses.add(
                    at,
                    'collapsed-run',
                    `run at cell ${offset} has no time`,
                );
            } else {
                const written = tag(start);
                // `[n|mm:ss:cc]` declares how many checks the column carries;
                // writing the count back keeps the piece count on a round trip.
                out +=
                    run.pieces.length > 1
                        ? `[${run.pieces.length}|${written.slice(1)}`
                        : written;
            }
        }
        // A comma is the separator of the `@Ruby` fields and has no escape. It
        // only has to go where an @Ruby parent covers it: there the parent
        // field loses it too, and leaving it in the body would stop the two
        // matching. The tag stays attached to its own run, so nothing shifts.
        const text = cells[offset].text;
        if (
            (text.includes(',') || text.includes('，')) &&
            covered.has(offset)
        ) {
            losses.add(
                at,
                'dropped-annotation',
                'a comma inside an @Ruby parent was removed from the body: this syntax has no escape for it',
            );
            continue;
        }
        out += escapeBody(text);
    }
    const end = (runs ?? []).at(-1);
    const endCheck = end?.pieces[0]?.check ?? null;
    if (endCheck !== null) {
        out += tag(endCheck.time);
    }
    return out;
}

/** Writes a document back as a time-tagged file. */
/**
 * The format says when a check happens, never which key produced it. Our
 * terminal run is the model's own line-end marker, so it does not count.
 */
function noteKeyUpLosses(lyrics: Lyrics, losses: LossCollector): void {
    for (const [index, line] of lyrics.lines.entries()) {
        const last = line.baseStream.cells.length - 1;
        for (const [name, runs] of Object.entries(line.groups)) {
            for (const run of runs) {
                const terminal = run.offset === last && run.length === 1;
                const keyUp = run.pieces.some(
                    (piece) => piece.check?.type === 'KeyUp',
                );
                if (terminal || !keyUp) {
                    continue;
                }
                losses.add(
                    `lines[${index}].groups.${name}`,
                    'dropped-check-kind',
                    'a check written as a tag cannot say it came from a key-up',
                );
            }
        }
    }
}

export function exportTagText(
    lyrics: Lyrics,
    options: TagExportOptions = {},
): Exported {
    const group = options.group ?? DEFAULT_GROUP;
    const losses = newLosses();
    noteKeyUpLosses(lyrics, losses);
    const body = lyrics.lines
        .map((line, index) => {
            const text = lineToText(
                line,
                group,
                `lines[${index}]`,
                losses,
                separatorsUnderRuby(line),
            );
            const last = line.baseStream.cells.at(-1);
            const rendered = `${text}${last === undefined ? '' : last.text}`;
            if (rendered.startsWith('@')) {
                // Directives only count at column 1, so a lyric line that starts
                // with `@` will be read back as a directive and vanish.
                losses.add(
                    `lines[${index}]`,
                    'unsupported-construct',
                    'the line starts with "@", which reads back as a directive',
                );
            }
            return rendered;
        })
        .join('');
    const rubies: string[] = [];
    let counter = 1;
    for (const line of lyrics.lines) {
        const runs = Object.hasOwn(line.groups, RUBY_GROUP)
            ? (line.groups[RUBY_GROUP] ?? [])
            : [];
        for (const run of runs) {
            if (run.offset >= line.baseStream.cells.length - 1) {
                continue;
            }
            rubies.push(
                `@Ruby${counter}=${formatRuby(line, run, null, losses, `@Ruby${counter}`)}`,
            );
            counter += 1;
        }
    }
    const headers = formatHeaders(lyrics.meta);
    const parts = [headers.join('\n'), body];
    if (rubies.length > 0) {
        parts.push(rubies.join('\n'));
    }
    // Exactly one blank line between blocks: the body already carries the last
    // line's own break, so adding a separator unconditionally would leave two.
    const blocks = parts.filter((part) => part !== '');
    let text = '';
    for (const block of blocks) {
        if (text !== '') {
            text += text.endsWith('\n') ? '\n' : '\n\n';
        }
        text += block;
    }
    if (text === '') {
        return { text: '', losses: losses.losses };
    }
    // The body carries the last line's own break; only a body that does not end
    // in one needs the closing newline.
    return {
        text: text.endsWith('\n') ? text : `${text}\n`,
        losses: losses.losses,
    };
}
