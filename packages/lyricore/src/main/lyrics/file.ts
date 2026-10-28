import type { CharCell, CharStream } from './char.js';
import { textToStream } from './char.js';
import { LyricoreError } from '../errors.js';
import { assertLyricsLine, lyricsLineToText, type LyricsLine } from './line.js';
import { assertLyrics, type Lyrics } from './lyrics.js';
import type { LyricsMeta } from './meta.js';
import { emptyMeta } from './meta.js';
import type { CheckPoint, CheckType, SegPiece, SegRun } from './seg-run.js';

/** Anything a stored time can be: `[start, duration]` in milliseconds. */
export type SpanFile = readonly [start: number, duration: number];

/** One cell time in the file: a span, or `null` while the cell is untimed. */
export type CellTimeFile = SpanFile | null;

/** The stored form of one annotation piece. */
export interface PieceFile {
    readonly check: CheckFile | null;
    readonly text: string;
    readonly spans?: readonly CellTimeFile[];
}

/** The stored form of one check record. */
export interface CheckFile {
    readonly time: number;
    readonly type: CheckType;
}

/** The stored form of one annotation run. */
export interface RunFile {
    readonly offset: number;
    readonly length: number;
    readonly pieces: readonly PieceFile[];
}

/** The stored form of one lyric line. */
export interface LineFile {
    readonly text: string;
    readonly spans?: readonly CellTimeFile[];
    readonly groups?: Readonly<Record<string, readonly RunFile[]>>;
}

/** The stored form of the metadata. Absent keys mean the empty value. */
export interface MetaFile {
    readonly title?: string;
    readonly artist?: string;
    readonly album?: string;
    readonly lyricist?: string;
    readonly compose?: string;
    readonly arrange?: string;
    readonly year?: string;
    readonly taggingBy?: string;
    readonly editedBy?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly renderer?: string;
    readonly version?: string;
    readonly language?: string;
    readonly offset?: number;
    readonly extra?: Readonly<Record<string, string>>;
}

/** One whole lyrics document as it is written to disk. */
export interface LyricsFile {
    readonly format: typeof FILE_FORMAT;
    readonly version: typeof FILE_VERSION;
    readonly meta?: MetaFile;
    readonly lines: readonly LineFile[];
}

const FILE_FORMAT = 'felyrics/lyrics';
const FILE_VERSION = 1;

const TEXT_FIELDS = [
    'title',
    'artist',
    'album',
    'lyricist',
    'compose',
    'arrange',
    'year',
    'taggingBy',
    'editedBy',
    'createdAt',
    'updatedAt',
    'renderer',
    'version',
    'language',
] as const;

const CHECK_TYPES: readonly CheckType[] = ['KeyDown', 'KeyUp'];

/** One document as the shape that goes to disk. */
export function lyricsToFile(lyrics: Lyrics): LyricsFile {
    return {
        format: FILE_FORMAT,
        version: FILE_VERSION,
        meta: metaToFile(lyrics.meta),
        lines: lyrics.lines.map(lineToFile),
    };
}

/** One document as pretty JSON text, with the cell times kept on one line. */
export function lyricsToJson(lyrics: Lyrics): string {
    const file = lyricsToFile(lyrics);
    const packed: string[] = [];
    const token = (spans: readonly CellTimeFile[]): string => {
        const body = spans
            .map((span) =>
                span === null ? 'null' : `[${span[0]}, ${span[1]}]`,
            )
            .join(', ');
        packed.push(`[${body}]`);
        return `\u0001${packed.length - 1}`;
    };
    const shrinkRun = (run: RunFile): RunFile => {
        const pieces = run.pieces.map((piece) => {
            return { ...piece, spans: token(piece.spans ?? []) };
        });
        return { ...run, pieces } as unknown as RunFile;
    };
    const shrunken = {
        ...file,
        lines: file.lines.map((line) => {
            const groups =
                line.groups === undefined
                    ? undefined
                    : Object.fromEntries(
                          Object.entries(line.groups).map(([name, list]) => {
                              return [name, list.map(shrinkRun)];
                          }),
                      );
            return { ...line, spans: token(line.spans ?? []), groups };
        }),
    };
    const text = JSON.stringify(shrunken, null, 2).replace(
        /"\\u0001(\d+)"/g,
        (_, index: string) => packed[Number(index)] ?? '[]',
    );
    return `${text}\n`;
}

/** Reads a document back from the shape produced by `lyricsToFile`. */
export function fileToLyrics(value: unknown): Lyrics {
    const root = requireRecord(value, 'file');
    if (root.format !== FILE_FORMAT) {
        fail('format', FILE_FORMAT, root.format);
    }
    if (root.version !== FILE_VERSION) {
        fail('version', String(FILE_VERSION), root.version);
    }
    const meta = metaFromFile(root.meta);
    const lines = requireArray(root.lines, 'lines').map((entry, index) => {
        return lineFromFile(entry, `lines[${index}]`);
    });
    const lyrics: Lyrics = { meta, lines };
    try {
        assertLyrics(lyrics);
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : 'the document is not usable';
        throw new LyricoreError('invalid-lyrics-file', message, {
            expected: 'a document that passes validation',
            actual: message,
        });
    }
    return lyrics;
}

/** Reads a document back from JSON text. */
export function jsonToLyrics(text: string): Lyrics {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        const detail =
            error instanceof Error ? error.message : 'the text is not JSON';
        throw new LyricoreError('invalid-lyrics-file', 'the text is not JSON', {
            expected: 'JSON text',
            actual: detail,
        });
    }
    return fileToLyrics(value);
}

function metaToFile(meta: LyricsMeta): MetaFile {
    const file: Record<string, unknown> = {};
    for (const field of TEXT_FIELDS) {
        if (meta[field] !== '') {
            file[field] = meta[field];
        }
    }
    if (meta.offset !== 0) {
        file.offset = meta.offset;
    }
    if (Object.keys(meta.extra).length > 0) {
        file.extra = meta.extra;
    }
    return file as MetaFile;
}

function lineToFile(line: LyricsLine): LineFile {
    const groups: Record<string, RunFile[]> = {};
    for (const [name, runs] of Object.entries(line.groups)) {
        groups[name] = runs.map(runToFile);
    }
    const text = lyricsLineToText(line);
    const spans = spansToFile(line.baseStream);
    if (Object.keys(groups).length === 0) {
        return { text, spans };
    }
    return { text, spans, groups };
}

function runToFile(run: SegRun): RunFile {
    return {
        offset: run.offset,
        length: run.length,
        pieces: run.pieces.map((piece) => pieceToFile(piece)),
    };
}

function pieceToFile(piece: SegPiece): PieceFile {
    return {
        check:
            piece.check === null
                ? null
                : { time: piece.check.time, type: piece.check.type },
        text: piece.text.cells.map((cell) => cell.text).join(''),
        spans: spansToFile(piece.text),
    };
}

function spansToFile(stream: CharStream): CellTimeFile[] {
    return stream.cells.map((cell) => {
        return cell.span === null
            ? null
            : [cell.span.start, cell.span.duration];
    });
}

function metaFromFile(value: unknown): LyricsMeta {
    if (value === undefined) {
        return emptyMeta();
    }
    const file = requireRecord(value, 'meta');
    const meta: Record<string, unknown> = {};
    for (const field of TEXT_FIELDS) {
        const entry = file[field];
        if (entry === undefined) {
            meta[field] = '';
        } else if (typeof entry === 'string') {
            meta[field] = entry;
        } else {
            fail(`meta.${field}`, 'a string', entry);
        }
    }
    meta.offset =
        file.offset === undefined
            ? 0
            : requireInteger(file.offset, 'meta.offset');
    if (file.extra === undefined) {
        meta.extra = {};
    } else {
        const extra = requireRecord(file.extra, 'meta.extra');
        const kept: Record<string, string> = {};
        for (const [key, entry] of Object.entries(extra)) {
            if (typeof entry !== 'string') {
                fail(`meta.extra.${key}`, 'a string', entry);
            }
            kept[key] = entry;
        }
        meta.extra = kept;
    }
    return meta as unknown as LyricsMeta;
}

function lineFromFile(value: unknown, path: string): LyricsLine {
    const file = requireRecord(value, path);
    const baseStream = streamFromFile(
        file.text,
        file.spans,
        `${path}.text`,
        path,
    );
    const groupsValue =
        file.groups === undefined
            ? {}
            : requireRecord(file.groups, `${path}.groups`);
    const groups: Record<string, SegRun[]> = {};
    for (const [name, runs] of Object.entries(groupsValue)) {
        groups[name] = requireArray(runs, `${path}.groups.${name}`).map(
            (entry, index) => {
                return runFromFile(entry, `${path}.groups.${name}[${index}]`);
            },
        );
    }
    const line: LyricsLine = { baseStream, groups };
    try {
        assertLyricsLine(line);
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'the line is not usable';
        throw new LyricoreError('invalid-lyrics-file', message, {
            expected: 'a line that passes validation',
            actual: message,
        });
    }
    return line;
}

function runFromFile(value: unknown, path: string): SegRun {
    const file = requireRecord(value, path);
    return {
        offset: requireInteger(file.offset, `${path}.offset`),
        length: requireInteger(file.length, `${path}.length`),
        pieces: requireArray(file.pieces, `${path}.pieces`).map(
            (entry, index) => {
                return pieceFromFile(entry, `${path}.pieces[${index}]`);
            },
        ),
    };
}

function pieceFromFile(value: unknown, path: string): SegPiece {
    const file = requireRecord(value, path);
    return {
        check: checkFromFile(file.check, `${path}.check`),
        text: streamFromFile(file.text, file.spans, `${path}.text`, path),
    };
}

function checkFromFile(value: unknown, path: string): CheckPoint | null {
    if (value === undefined || value === null) {
        return null;
    }
    const file = requireRecord(value, path);
    const type = file.type;
    if (typeof type !== 'string' || !CHECK_TYPES.includes(type as CheckType)) {
        fail(`${path}.type`, CHECK_TYPES.join(' or '), type);
    }
    return {
        time: requireInteger(file.time, `${path}.time`),
        type: type as CheckType,
    };
}

function streamFromFile(
    text: unknown,
    spans: unknown,
    textPath: string,
    path: string,
): CharStream {
    if (typeof text !== 'string') {
        fail(textPath, 'a string', text);
    }
    const cells = textToStream(text).cells;
    if (spans === undefined) {
        return { cells };
    }
    const list = requireArray(spans, `${path}.spans`);
    if (list.length !== cells.length) {
        fail(
            `${path}.spans`,
            `${cells.length} entries for ${cells.length} cells`,
            list.length,
        );
    }
    return {
        cells: cells.map((cell, index): CharCell => {
            return {
                text: cell.text,
                span: spanFromFile(list[index], `${path}.spans[${index}]`),
            };
        }),
    };
}

function spanFromFile(
    value: unknown,
    path: string,
): { start: number; duration: number } | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length !== 2) {
        fail(path, '[start, duration]', value);
    }
    return {
        start: requireInteger(value[0], `${path}[0]`),
        duration: requireInteger(value[1], `${path}[1]`),
    };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(path, 'an object', value);
    }
    return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
    if (!Array.isArray(value)) {
        fail(path, 'an array', value);
    }
    return value;
}

function requireInteger(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        fail(path, 'an integer', value);
    }
    return value;
}

function fail(path: string, expected: string, actual: unknown): never {
    throw new LyricoreError(
        'invalid-lyrics-file',
        `lyrics file cannot be read at ${path}`,
        {
            expected,
            actual: describe(actual),
        },
    );
}

function describe(value: unknown): string {
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return `an array of ${value.length}`;
    }
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'object') {
        return 'an object';
    }
    return typeof value;
}
