import type { Lyrics } from '../lyrics/lyrics.js';
import type { LyricsLine } from '../lyrics/line.js';
import { TIME_MAX } from '../lyrics/time.js';
import { formatLrcHeaders } from './headers.js';
import { newLosses } from './loss.js';
import {
    DEFAULT_GROUP,
    importTagText,
    LAST_LINE_MS,
    type Exported,
    type Imported,
} from './tagtext.js';
import { formatTag } from './tags.js';

/**
 * LRC is the same grammar as the time-tag format with one tag per line, so
 * reading it needs nothing extra: headers and tags are already accepted by the
 * shared parser.
 */
export function importLrc(text: string): Imported {
    return importTagText(text);
}

/**
 * Reports what LRC cannot hold, given the one time a line gets. The chunk group
 * is the line's own segmentation, so it only costs something when a chunk
 * starts later than the line does.
 */
function lineLosses(
    line: LyricsLine,
    start: number,
    at: string,
    losses: ReturnType<typeof newLosses>,
): void {
    for (const group of Object.keys(line.groups)) {
        if (group !== DEFAULT_GROUP) {
            losses.add(
                at,
                'dropped-annotation',
                `LRC has no annotation stream (group "${group}")`,
            );
            continue;
        }
        const late = (line.groups[group] ?? []).some((run) => {
            if (run.offset >= line.baseStream.cells.length - 1) {
                return false;
            }
            const time = run.pieces[0]?.check?.time ?? null;
            return time !== null && time !== start;
        });
        if (late) {
            losses.add(
                at,
                'collapsed-run',
                'LRC dates the line, so inner chunk starts are lost',
            );
        }
    }
}

/** The first timed body cell at or after `from`, i.e. where the next line starts. */
function nextStart(lyrics: Lyrics, from: number): number | null {
    for (let index = from; index < lyrics.lines.length; index += 1) {
        const cells = lyrics.lines[index]!.baseStream.cells;
        const body = cells.slice(0, Math.max(0, cells.length - 1));
        const first = body.find((cell) => cell.span !== null);
        if (first !== undefined) {
            return first.span!.start;
        }
    }
    return null;
}

/** Writes one tag per line: LRC's whole vocabulary. */
export function exportLrc(lyrics: Lyrics): Exported {
    const losses = newLosses();
    const out: string[] = formatLrcHeaders(lyrics.meta);
    for (const [index, line] of lyrics.lines.entries()) {
        const at = `lines[${index}]`;
        const cells = line.baseStream.cells;
        // The break cell carries the line's END; taking it as the line start
        // would write the end time as the beginning.
        const body = cells.slice(0, Math.max(0, cells.length - 1));
        const first = body.find((cell) => cell.span !== null);
        if (first === undefined) {
            losses.add(at, 'source-ignored', 'the line has no timed cell');
            continue;
        }
        const start = first.span!.start;
        lineLosses(line, start, at, losses);
        const text = body.map((cell) => cell.text).join('');
        // A bare tag ends the line. It is only worth writing when the end the
        // document holds differs from the next line's start and is later than
        // the line's own start; otherwise the next tag already says the same
        // thing, or the tag would contradict the line it ends.
        //
        // A last line has no next tag to be the natural end, so the reader
        // invents one: its last check plus `LAST_LINE_MS`. A bare tag also
        // spells a RECORDED end, so one is written whenever the document holds
        // an end the reader would not fabricate -- dropping it silently loses
        // the time. An end that happens to equal the fabricated value cannot
        // be told apart from the default and is left out.
        const end = cells[cells.length - 1]?.span?.start;
        const next = nextStart(lyrics, index + 1);
        // The text this line becomes carries ONE tag, so the reader of it
        // dates the single run from `start` and, on a last line, invents an end
        // at `start + LAST_LINE_MS`. Comparing against the in-memory last check
        // instead would compare against a run the export never writes.
        const fabricated = Math.min(TIME_MAX, start + LAST_LINE_MS);
        const tail =
            end !== undefined &&
            end > start &&
            end !== next &&
            (next !== null || end !== fabricated)
                ? formatTag(end)
                : '';
        // A tail equal to the line start is expressible, but many players read
        // a repeated timestamp as a zero-length entry, so it stays out. When two
        // lines share an instant the next tag says the same thing anyway.
        if (tail !== '' && end !== undefined && end % 10 !== 0) {
            losses.add(
                at,
                'time-truncated',
                `${end} ms written as ${Math.floor(end / 10) * 10} ms: the format counts whole centiseconds, so ${end % 10} ms was lost`,
            );
        }
        out.push(`${formatTag(start)}${text}${tail}`);
    }
    return {
        text: out.length === 0 ? '' : `${out.join('\n')}\n`,
        losses: losses.losses,
    };
}
