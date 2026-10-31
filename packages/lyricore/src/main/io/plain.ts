import { textToLyricsLine } from '../lyrics/line.js';
import { lyricsOf, type Lyrics } from '../lyrics/lyrics.js';
import { emptyMeta, isSameMeta } from '../lyrics/meta.js';
import type { LyricsMeta } from '../lyrics/meta.js';
import { newLosses, type Loss } from './loss.js';
import { ensureTrailingBreak, splitLines } from './text.js';

export interface Imported {
    readonly lyrics: Lyrics;
    readonly losses: readonly Loss[];
}

export interface Exported {
    readonly text: string;
    readonly losses: readonly Loss[];
}

/**
 * Plain text is lyric content with no timing and no annotation. Each line
 * becomes one `LyricsLine` with every span unset.
 */
export function importPlainText(
    text: string,
    meta: LyricsMeta = emptyMeta(),
): Imported {
    const losses = newLosses();
    const lines = splitLines(ensureTrailingBreak(text, 'file', losses)).map(
        (line) => textToLyricsLine(line.content + line.break),
    );
    return { lyrics: lyricsOf(meta, lines), losses: losses.losses };
}

/** Writes the base text only; timing, annotation and metadata cannot follow. */
export function exportPlainText(lyrics: Lyrics): Exported {
    const losses = newLosses();
    const text = lyrics.lines
        .map((line) => line.baseStream.cells.map((cell) => cell.text).join(''))
        .join('');
    for (const [at, line] of lyrics.lines.entries()) {
        if (line.baseStream.cells.some((cell) => cell.span !== null)) {
            losses.add(
                `lines[${at}]`,
                'source-ignored',
                'plain text carries no timing',
            );
        }
        if (Object.keys(line.groups).length > 0) {
            losses.add(
                `lines[${at}]`,
                'dropped-annotation',
                'plain text carries no annotation',
            );
        }
    }
    if (!isSameMeta(lyrics.meta, emptyMeta())) {
        losses.add(
            'meta',
            'meta-unsupported',
            'plain text carries no metadata',
        );
    }
    return { text, losses: losses.losses };
}
