import { isTime } from './time.js';

export interface LyricsMeta {
    readonly title: string;
    readonly artist: string;
    readonly album: string;
    readonly lyricist: string;
    readonly compose: string;
    readonly arrange: string;
    readonly year: string;
    readonly taggingBy: string;
    readonly editedBy: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly renderer: string;
    readonly version: string;
    readonly language: string;
    readonly offset: number;
    readonly extra: Readonly<Record<string, string>>;
}

export function emptyMeta(): LyricsMeta {
    return {
        title: '',
        artist: '',
        album: '',
        lyricist: '',
        compose: '',
        arrange: '',
        year: '',
        taggingBy: '',
        editedBy: '',
        createdAt: '',
        updatedAt: '',
        renderer: '',
        version: '',
        language: '',
        offset: 0,
        extra: {},
    };
}

const TEXT_KEYS: readonly (keyof LyricsMeta)[] = [
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
];

export function isValidMeta(meta: LyricsMeta): boolean {
    if (!isTime(meta.offset)) {
        return false;
    }
    if (!TEXT_KEYS.every((key) => typeof meta[key] === 'string')) {
        return false;
    }
    return Object.values(meta.extra).every(
        (value) => typeof value === 'string',
    );
}

/** Whether two values say the same thing, field by field, `extra` by value. */
export function isSameMeta(left: LyricsMeta, right: LyricsMeta): boolean {
    if (left.offset !== right.offset) {
        return false;
    }
    if (!TEXT_KEYS.every((key) => left[key] === right[key])) {
        return false;
    }
    const leftExtra = Object.entries(left.extra);
    const rightExtra = Object.entries(right.extra);
    if (leftExtra.length !== rightExtra.length) {
        return false;
    }
    return leftExtra.every(([key, value]) => right.extra[key] === value);
}
