import type { CharCell } from '../lyrics/char.js';
import { textToStream } from '../lyrics/char.js';
import type { LyricsLine } from '../lyrics/line.js';
import type { Lyrics } from '../lyrics/lyrics.js';
import type { SegPiece, SegRun } from '../lyrics/seg-run.js';
import { isTime } from '../lyrics/time.js';
import type { LossCollector } from './loss.js';
import { parseTag } from './tags.js';

/**
 * One `@RubyN=TT,RR[,t1][,t2]` line. `TT` is the text the reading replaces,
 * `RR` the reading itself (it may carry `[mm:ss:cc]` offsets), and the two
 * optional fields bound the window in which this entry applies.
 */
export interface RubyEntry {
    /** Index after `@Ruby`, or null when the tag carries no number. */
    readonly index: number | null;
    /** `TT`: the text the reading belongs to. */
    readonly parent: string;
    /** `RR`: the reading, its offsets still embedded. */
    readonly reading: string;
    /** Raw `t1` field, or '' when the entry starts with the song. */
    readonly startField: string;
    /** Raw `t2` field, or '' when the entry runs to the song's end. */
    readonly endField: string;
}

const RUBY_LINE = /^@Ruby(\d*)\s*=(.*)$/i;
const INLINE_TAG = /\[(\d{1,3}):(\d{2})(?::(\d{1,2}))?\]/g;

/** Parses `@RubyN=TT,RR[,t1][,t2]`; returns null for every other line. */
export function parseRubyLine(content: string): RubyEntry | null {
    // A directive only counts at column 1: the standard says `@` lines are
    // directives, and a body line that merely starts with a space is lyric
    // text. Trimming here swallowed such lines.
    const head = RUBY_LINE.exec(content.replace(/\s+$/, ''));
    const rest = head?.[2];
    if (rest === undefined) {
        return null;
    }
    const fields = rest.split(',');
    if (fields.length < 2) {
        return null;
    }
    const digits = head?.[1] ?? '';
    return {
        index: digits === '' ? null : Number.parseInt(digits, 10),
        parent: (fields[0] ?? '').trim(),
        reading: fields[1] ?? '',
        startField: (fields[2] ?? '').trim(),
        endField: (fields[3] ?? '').trim(),
    };
}

/** One chunk of a reading: its text plus the offset that starts it, if any. */
export interface ReadingChunk {
    readonly text: string;
    /** Offset in ms from the parent's start, or null for the leading chunk. */
    readonly offset: number | null;
}

/** Splits a reading on its inline `[mm:ss:cc]` offsets. */
export function splitReading(reading: string): ReadingChunk[] {
    const chunks: ReadingChunk[] = [];
    let at = 0;
    for (;;) {
        const match = INLINE_TAG.exec(reading);
        const before = reading.slice(
            at,
            match === null ? reading.length : match.index,
        );
        if (before !== '') {
            chunks.push({ text: before, offset: null });
        }
        if (match === null) {
            return chunks;
        }
        chunks.push({ text: '', offset: tagMilliseconds(match) });
        at = match.index + match[0].length;
    }
}

/** Joins chunks back into a reading, writing offsets only where they start. */
export function joinReading(chunks: readonly ReadingChunk[]): string {
    let out = '';
    for (const chunk of chunks) {
        if (chunk.offset !== null) {
            out += formatOffset(chunk.offset);
        }
        out += chunk.text;
    }
    return out;
}

function tagMilliseconds(match: RegExpExecArray): number {
    const minutes = Number.parseInt(match[1] ?? '0', 10);
    const seconds = Number.parseInt(match[2] ?? '0', 10);
    const fraction = Number.parseInt(match[3] ?? '0', 10);
    return minutes * 60_000 + seconds * 1_000 + fraction * 10;
}

/** `[mm:ss:cc]` for a millisecond value; centiseconds are truncated and the sign has no grammar. */
export function formatOffset(ms: number): string {
    const at = Math.max(0, ms);
    const minutes = Math.floor(at / 60_000);
    const seconds = Math.floor((at % 60_000) / 1_000);
    const fraction = Math.floor((at % 1_000) / 10);
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(fraction).padStart(2, '0')}]`;
}

function textOf(
    cells: readonly CharCell[],
    from: number,
    count: number,
): string {
    return cells
        .slice(from, from + count)
        .map((cell) => cell.text)
        .join('');
}

function startOf(cell: CharCell | undefined): number | null {
    return cell === undefined || cell.span === null ? null : cell.span.start;
}

/** Reads a `[mm:ss:cc]` field; bare numbers are accepted too. */
function fieldMilliseconds(field: string): number | null {
    const inner = field
        .replace(/^\s*\[/, '')
        .replace(/\]\s*$/, '')
        .trim();
    return inner === '' ? null : parseTag(inner);
}

function windowOf(entry: RubyEntry): readonly [number | null, number | null] {
    return [
        fieldMilliseconds(entry.startField),
        fieldMilliseconds(entry.endField),
    ];
}

function acceptsWindow(
    window: readonly [number | null, number | null],
    start: number | null,
): boolean {
    if (start === null) {
        return true;
    }
    const [from, to] = window;
    if (from !== null && start < from) {
        return false;
    }
    // Both bounds are inclusive: the spec says "at or after" the start and "at
    // or before" the end (the end switched from exclusive to inclusive in the
    // 2020-11-22 revision of the extension).
    return to === null || start <= to;
}

/**
 * Spreads a run's pieces across the window they own: each piece holds from its
 * own check to the next one, and the last one to the parent's end.
 */
export function timeAnnotation(run: SegRun, parentEnd: number | null): SegRun {
    const pieces: SegPiece[] = [];
    for (let at = 0; at < run.pieces.length; at += 1) {
        const piece = run.pieces[at];
        if (piece === undefined) {
            continue;
        }
        const start = piece.check === null ? null : piece.check.time;
        const next = run.pieces[at + 1];
        const nextStart =
            next === undefined ? parentEnd : (next.check?.time ?? null);
        const cells = piece.text.cells;
        const end = nextStart === null || start === null ? null : nextStart;
        pieces.push({
            check: piece.check,
            text: {
                cells: cells.map((cell, index) => {
                    if (
                        start === null ||
                        end === null ||
                        end <= start ||
                        cells.length === 0
                    ) {
                        return cell;
                    }
                    const step = Math.floor((end - start) / cells.length);
                    const rest = (end - start) % cells.length;
                    const span = {
                        start: start + step * index + Math.min(index, rest),
                        duration: step + (index < rest ? 1 : 0),
                    };
                    return {
                        text: cell.text,
                        span: isTime(span.start) ? span : null,
                    };
                }),
            },
        });
    }
    return { ...run, pieces };
}

/**
 * Resolves every entry against the line: the first unclaimed occurrence of the
 * parent that also falls inside the entry's window wins.
 */
export function resolveRuby(
    line: LyricsLine,
    entries: readonly RubyEntry[],
    at: string,
    losses: LossCollector,
): SegRun[] {
    const cells = line.baseStream.cells;
    const claimed = new Uint8Array(cells.length);
    const runs: SegRun[] = [];
    for (const entry of entries) {
        if (entry.parent === '') {
            losses.add(
                at,
                'unsupported-construct',
                'a @Ruby line has no parent text',
            );
            continue;
        }
        const width = textToStream(entry.parent).cells.length;
        let placed = false;
        for (
            let start = 0;
            start + width <= cells.length && !placed;
            start += 1
        ) {
            let free = true;
            for (let at2 = start; at2 < start + width; at2 += 1) {
                if (claimed[at2] !== 0) {
                    free = false;
                    break;
                }
            }
            if (!free || textOf(cells, start, width) !== entry.parent) {
                continue;
            }
            if (!acceptsWindow(windowOf(entry), startOf(cells[start]))) {
                continue;
            }
            for (let at2 = start; at2 < start + width; at2 += 1) {
                claimed[at2] = 1;
            }
            const run = runFromEntry(
                entry,
                start,
                width,
                startOf(cells[start]),
            );
            const last = cells[start + width - 1];
            const parentEnd =
                last?.span === undefined || last.span === null
                    ? null
                    : last.span.start + last.span.duration;
            runs.push(timeAnnotation(run, parentEnd));
            placed = true;
        }
        if (!placed) {
            losses.add(
                at,
                'unsupported-construct',
                `@Ruby "${entry.parent}" has no unclaimed occurrence in this line`,
            );
        }
    }
    return runs.sort((left, right) => left.offset - right.offset);
}

function runFromEntry(
    entry: RubyEntry,
    offset: number,
    length: number,
    parentStart: number | null,
): SegRun {
    const pieces: SegPiece[] = [];
    let time = parentStart;
    for (const chunk of splitReading(entry.reading)) {
        if (chunk.offset !== null) {
            time = parentStart === null ? null : parentStart + chunk.offset;
        }
        if (chunk.text === '') {
            continue;
        }
        pieces.push({
            check: time === null ? null : { time, type: 'KeyDown' },
            text: textToStream(chunk.text),
        });
    }
    return { offset, length, pieces };
}

/**
 * Applies every `@Ruby` entry to the document in file order: each entry claims
 * the first unclaimed occurrence of its parent text that its window accepts.
 */
export function applyRuby(
    lyrics: Lyrics,
    entries: readonly RubyEntry[],
    group: string,
    at: string,
    losses: LossCollector,
): Lyrics {
    if (entries.length === 0) {
        return lyrics;
    }
    const claimed = lyrics.lines.map((line) => {
        const cells = line.baseStream.cells.length;
        const used = new Uint8Array(cells);
        const existing = Object.hasOwn(line.groups, group)
            ? (line.groups[group] ?? [])
            : [];
        for (const run of existing) {
            // The terminal run marks the line break, not an annotation.
            if (run.offset === cells - 1 && run.length === 1) {
                continue;
            }
            const end = Math.min(cells, run.offset + run.length);
            for (let cell = Math.max(0, run.offset); cell < end; cell += 1) {
                used[cell] = 1;
            }
        }
        return used;
    });
    const added: SegRun[][] = lyrics.lines.map(() => []);
    for (const entry of entries) {
        if (entry.parent === '') {
            losses.add(
                at,
                'unsupported-construct',
                'a @Ruby line has no parent text',
            );
            continue;
        }
        const width = textToStream(entry.parent).cells.length;
        const window = windowOf(entry);
        let placed = false;
        for (
            let index = 0;
            index < lyrics.lines.length && !placed;
            index += 1
        ) {
            const cells = lyrics.lines[index]?.baseStream.cells ?? [];
            const used = claimed[index];
            if (used === undefined) {
                continue;
            }
            for (let start = 0; start + width <= cells.length; start += 1) {
                let free = true;
                for (let inner = start; inner < start + width; inner += 1) {
                    if (used[inner] !== 0) {
                        free = false;
                        break;
                    }
                }
                if (!free || textOf(cells, start, width) !== entry.parent) {
                    continue;
                }
                if (!acceptsWindow(window, startOf(cells[start]))) {
                    continue;
                }
                for (let inner = start; inner < start + width; inner += 1) {
                    used[inner] = 1;
                }
                // An entry with no reading cancels the ruby over its window: the
                // occurrence is claimed so no later entry can re-attach one.
                if (entry.reading === '') {
                    placed = true;
                    break;
                }
                const run = runFromEntry(
                    entry,
                    start,
                    width,
                    startOf(cells[start]),
                );
                const last = cells[start + width - 1];
                const parentEnd =
                    last?.span === undefined || last.span === null
                        ? null
                        : last.span.start + last.span.duration;
                added[index]?.push(timeAnnotation(run, parentEnd));
                placed = true;
                break;
            }
        }
        if (!placed) {
            losses.add(
                at,
                'unsupported-construct',
                `@Ruby "${entry.parent}" has no unclaimed occurrence that its window accepts`,
            );
        }
    }
    return {
        ...lyrics,
        lines: lyrics.lines.map((line, index) => {
            const runs = [...(added[index] ?? [])];
            if (runs.length === 0) {
                return line;
            }
            const existing = Object.hasOwn(line.groups, group)
                ? [...(line.groups[group] ?? [])]
                : [];
            const merged = [...existing, ...runs].sort(
                (left, right) => left.offset - right.offset,
            );
            const cells = line.baseStream.cells.length;
            const last = merged[merged.length - 1];
            if (last === undefined || last.offset !== cells - 1) {
                merged.push({
                    offset: cells - 1,
                    length: 1,
                    pieces: [{ check: null, text: textToStream('') }],
                });
            }
            return {
                baseStream: line.baseStream,
                groups: { ...line.groups, [group]: merged },
            };
        }),
    };
}

/**
 * Writes one run back out as `TT,RR[,t1][,t2]`. A comma inside either field is
 * a separator in this syntax and there is no escape for it, so such a comma is
 * removed: the line stays readable, at the cost of the character.
 */
export function formatRuby(
    line: LyricsLine,
    run: SegRun,
    nextStart: number | null,
    losses: LossCollector | null = null,
    at = '@Ruby',
): string {
    const cells = line.baseStream.cells;
    const parent = withoutSeparator(
        textOf(cells, run.offset, run.length),
        '親文字',
        losses,
        at,
    );
    const first = startOf(cells[run.offset]);
    const last = cells[run.offset + run.length - 1];
    const end =
        first !== null && last?.span !== undefined && last.span !== null
            ? last.span.start + last.span.duration
            : nextStart;
    const reading = withoutSeparator(
        joinReading(
            run.pieces.map((piece) => ({
                text: piece.text.cells.map((cell) => cell.text).join(''),
                // The first piece starts with the parent, so it needs no offset.
                offset:
                    piece.check === null ||
                    first === null ||
                    piece.check.time === first
                        ? null
                        : piece.check.time - first,
            })),
        ),
        'ルビ',
        losses,
        at,
    );
    const from = first === null ? '' : formatOffset(first);
    const to = end === null || !isTime(end) ? '' : formatOffset(end);
    return `${parent},${reading},${from},${to}`;
}

/** Drops the commas a field cannot carry, reporting what went missing. */
function withoutSeparator(
    field: string,
    name: string,
    losses: LossCollector | null,
    at: string,
): string {
    const stripped = field.replace(/[,，]/gu, '');
    if (stripped !== field && losses !== null) {
        losses.add(
            at,
            'dropped-annotation',
            `a ${name} field contained a comma, which this syntax cannot carry`,
        );
    }
    return stripped;
}
