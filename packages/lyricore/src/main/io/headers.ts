import { isTime } from '../lyrics/time.js';
import type { LyricsMeta } from '../lyrics/meta.js';
import type { LossCollector } from './loss.js';

/** One metadata line: `@Title=...` (time-tag format) or `[ti:...]` (LRC). */
export interface Header {
    readonly key: string;
    readonly value: string;
    readonly form: 'at' | 'bracket';
}

const AT_HEADER = /^@([A-Za-z][A-Za-z0-9_]*)=(.*)$/;
const BRACKET_HEADER = /^\[([A-Za-z]+):(.*)\]$/;

/**
 * Reads a metadata line. A bracket whose key is not letters (`[00:01:00]`) is
 * not a header, so time tags never land here.
 */
export function parseHeader(content: string): Header | null {
    const at = AT_HEADER.exec(content);
    if (at !== null) {
        return { key: at[1]!, value: at[2]!, form: 'at' };
    }
    const bracket = BRACKET_HEADER.exec(content);
    if (bracket !== null) {
        return {
            key: bracket[1]!,
            value: bracket[2]!,
            form: 'bracket',
        };
    }
    return null;
}

/**
 * Which field a header key fills. Different spellings of the same idea live
 * here (`@Lyrics=` is the time-tag word for the lyricist), so the rest of the
 * code only ever deals with field names.
 */
const FIELDS: Readonly<Record<string, keyof LyricsMeta>> = {
    title: 'title',
    ti: 'title',
    artist: 'artist',
    ar: 'artist',
    album: 'album',
    al: 'album',
    lyrics: 'lyricist',
    lr: 'lyricist',
    compose: 'compose',
    arrange: 'arrange',
    year: 'year',
    taggingby: 'taggingBy',
    by: 'taggingBy',
    editedby: 'editedBy',
    renderer: 'renderer',
    re: 'renderer',
    ve: 'version',
    version: 'version',
    offset: 'offset',
};

/** Fields written as `@Key=` in the time-tag format, in the order they go out. */
const AT_ORDER: readonly (readonly [keyof LyricsMeta, string])[] = [
    ['title', 'Title'],
    ['artist', 'Artist'],
    ['album', 'Album'],
    ['lyricist', 'Lyrics'],
    ['compose', 'Compose'],
    ['arrange', 'Arrange'],
    ['year', 'Year'],
    ['taggingBy', 'TaggingBy'],
    ['editedBy', 'EditedBy'],
];

/** Fields written as `[key:value]` in LRC. */
const LRC_ORDER: readonly (readonly [keyof LyricsMeta, string])[] = [
    ['title', 'ti'],
    ['artist', 'ar'],
    ['album', 'al'],
    ['lyricist', 'lr'],
    ['taggingBy', 'by'],
];

/**
 * Applies one header to the metadata. A time value that is not a time is a
 * loss, not a thrown error: a file may carry an `@Offset` this reader cannot
 * use, and the rest of the file is still worth reading.
 */
export function withHeader(
    meta: LyricsMeta,
    header: Header,
    at: string,
    losses: LossCollector,
): LyricsMeta {
    const key = header.key.toLowerCase();
    // `FIELDS` is an object literal, so a bracket field named `constructor`
    // would otherwise resolve to `Object`, not to "unknown".
    const field = Object.hasOwn(FIELDS, key) ? FIELDS[key] : undefined;
    if (field === undefined) {
        return {
            ...meta,
            extra: { ...meta.extra, [header.key]: header.value },
        };
    }
    if (field === 'offset') {
        const value = Number(header.value.trim());
        if (!Number.isInteger(value) || !isTime(value)) {
            losses.add(
                at,
                'meta-unsupported',
                `${header.key}: "${header.value}" is not a time`,
            );
            return meta;
        }
        return { ...meta, offset: value };
    }
    return { ...meta, [field]: header.value };
}

function valueOf(meta: LyricsMeta, field: keyof LyricsMeta): string {
    const value = meta[field];
    return typeof value === 'string' ? value : '';
}

/** The `@Key=value` block a time-tag file starts with. */
export function formatHeaders(meta: LyricsMeta): string[] {
    const lines: string[] = [];
    for (const [field, key] of AT_ORDER) {
        const value = valueOf(meta, field);
        if (value !== '') {
            lines.push(`@${key}=${value}`);
        }
    }
    if (meta.offset !== 0) {
        lines.push(`@Offset=${meta.offset}`);
    }
    for (const [key, value] of Object.entries(meta.extra)) {
        lines.push(`@${key}=${value}`);
    }
    return lines;
}

/** The `[key:value]` block an LRC file starts with. */
export function formatLrcHeaders(meta: LyricsMeta): string[] {
    const lines: string[] = [];
    for (const [field, key] of LRC_ORDER) {
        const value = valueOf(meta, field);
        if (value !== '') {
            lines.push(`[${key}:${value}]`);
        }
    }
    if (meta.offset !== 0) {
        lines.push(`[offset:${meta.offset}]`);
    }
    if (meta.renderer !== '') {
        lines.push(`[re:${meta.renderer}]`);
    }
    if (meta.version !== '') {
        lines.push(`[ve:${meta.version}]`);
    }
    return lines;
}
