import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    exportToLyrics,
    readExportJson,
    lyricsToExport,
    lyricsToExportJson,
} from '../../src/main/lyrics/file.js';
import { emptyMeta } from '../../src/main/lyrics/meta.js';

function cell(text, span = null) {
    return { text, span };
}

function stream(cells) {
    return { cells };
}

function check(time, type = 'KeyDown') {
    return { time, type };
}

/** "あい\n" timed 0 / 500 / 1000 with a ruby run over the first two cells. */
function timed() {
    return {
        meta: {
            ...emptyMeta(),
            title: 'Song',
            offset: -250,
            extra: { bgfile: 'bg.png' },
        },
        lines: [
            {
                baseStream: stream([
                    cell('あ', { start: 0, duration: 500 }),
                    cell('い', { start: 500, duration: 500 }),
                    cell('\n', { start: 1_000, duration: 500 }),
                ]),
                groups: {
                    ruby: [
                        {
                            offset: 0,
                            length: 2,
                            pieces: [
                                { check: check(0), text: stream([cell('あ')]) },
                                { check: null, text: stream([cell('い')]) },
                            ],
                        },
                        {
                            offset: 2,
                            length: 1,
                            pieces: [{ check: null, text: stream([]) }],
                        },
                    ],
                },
                // The export format does not carry the overlay, so a read
                // gives the empty one back: this fixture states that on
                // purpose.
                overlay: {
                    styles: [],
                    inserted: [],
                    blocks: [],
                    runStyles: [],
                    annotations: [],
                },
            },
        ],
        // The same holds for the two document-level layers: a lyrics export
        // carries neither, so a read brings the empty ones back.
        styleBook: { defs: {} },
        animations: [],
    };
}

function own(error, code) {
    return error instanceof Error && error.code === code;
}

describe('the lyrics export', () => {
    it('round trips a timed document without changing anything', () => {
        const before = timed();
        const after = exportToLyrics(lyricsToExport(before));
        assert.deepEqual(after, before);
    });

    it('refuses to export a document the reader would reject', () => {
        const lyrics = { meta: { ...emptyMeta(), offset: 1.5 }, lines: [] };

        assert.throws(
            () => lyricsToExport(lyrics),
            (error) => own(error, 'invalid-lyrics-meta'),
        );
    });

    it('round trips through JSON text', () => {
        const before = timed();
        assert.deepEqual(readExportJson(lyricsToExportJson(before)), before);
        assert.equal(lyricsToExportJson(before).endsWith('\n'), true);
    });

    it('keeps a group name and a metadata key named __proto__', () => {
        // The computed keys are load-bearing: a plain `__proto__` in a literal
        // sets the prototype instead of creating an own property.
        const before = {
            meta: { ...emptyMeta(), extra: { ['__proto__']: 'kept' } },
            lines: [
                {
                    baseStream: stream([
                        cell('あ', { start: 0, duration: 500 }),
                        cell('\n', { start: 500, duration: 500 }),
                    ]),
                    groups: {
                        ['__proto__']: [
                            {
                                offset: 0,
                                length: 1,
                                pieces: [
                                    {
                                        check: check(0),
                                        text: stream([cell('あ')]),
                                    },
                                ],
                            },
                            {
                                offset: 1,
                                length: 1,
                                pieces: [{ check: null, text: stream([]) }],
                            },
                        ],
                    },
                    overlay: {
                        styles: [],
                        inserted: [],
                        blocks: [],
                        runStyles: [],
                        annotations: [],
                    },
                },
            ],
            styleBook: { defs: {} },
            animations: [],
        };
        const text = lyricsToExportJson(before);
        assert.equal(text.includes('"__proto__"'), true);
        const after = readExportJson(text);
        assert.equal(Object.hasOwn(after.lines[0].groups, '__proto__'), true);
        assert.equal(Object.hasOwn(after.meta.extra, '__proto__'), true);
        assert.deepEqual(after, before);
    });

    it('writes only the metadata it has and reads the empty values back', () => {
        const exported = lyricsToExport({
            meta: { ...emptyMeta(), title: 'Song' },
            lines: [],
        });
        assert.deepEqual(exported.meta, { title: 'Song' });
        const back = exportToLyrics(exported);
        assert.deepEqual(back.meta, { ...emptyMeta(), title: 'Song' });
    });

    it('leaves the groups out when a line has no annotation', () => {
        const exported = lyricsToExport({
            meta: emptyMeta(),
            lines: [
                {
                    baseStream: stream([cell('あ'), cell('\n')]),
                    groups: {},
                    overlay: {
                        styles: [],
                        inserted: [],
                        blocks: [],
                        runStyles: [],
                        annotations: [],
                    },
                },
            ],
        });
        assert.equal(exported.lines[0].groups, undefined);
        assert.deepEqual(exported.lines[0].spans, [null, null]);
    });

    it('never writes the overlay into the frozen lyrics export', () => {
        const lyrics = timed();
        assert.deepEqual(lyrics.lines[0].overlay, {
            styles: [],
            inserted: [],
            blocks: [],
            runStyles: [],
            annotations: [],
        });
        const exported = lyricsToExport(lyrics);
        assert.equal(
            Object.hasOwn(exported.lines[0], 'overlay'),
            false,
            'the overlay travels with the model, never with the frozen export',
        );
    });

    it('reads every cell as untimed when the spans are not written', () => {
        const back = exportToLyrics({
            format: 'felyrics/lyrics',
            version: 1,
            lines: [{ text: 'あい\n' }],
        });
        assert.deepEqual(
            back.lines[0].baseStream.cells.map((entry) => entry.span),
            [null, null, null],
        );
    });

    it('refuses another format or version', () => {
        assert.throws(
            () =>
                exportToLyrics({
                    format: 'other/thing',
                    version: 1,
                    lines: [],
                }),
            (error) => own(error, 'invalid-lyrics-file'),
        );
        assert.throws(
            () =>
                exportToLyrics({
                    format: 'felyrics/lyrics',
                    version: 2,
                    lines: [],
                }),
            (error) => own(error, 'invalid-lyrics-file'),
        );
    });

    it('refuses a span list that does not match the cells it segments into', () => {
        assert.throws(
            () =>
                exportToLyrics({
                    format: 'felyrics/lyrics',
                    version: 1,
                    lines: [
                        {
                            text: 'あい\n',
                            spans: [
                                [0, 100],
                                [100, 100],
                            ],
                        },
                    ],
                }),
            (error) => own(error, 'invalid-lyrics-file'),
        );
    });

    it('refuses a check it does not know', () => {
        assert.throws(
            () =>
                exportToLyrics({
                    format: 'felyrics/lyrics',
                    version: 1,
                    lines: [
                        {
                            text: 'あ\n',
                            groups: {
                                ruby: [
                                    {
                                        offset: 0,
                                        length: 2,
                                        pieces: [
                                            {
                                                check: { time: 0, type: 'Tap' },
                                                text: '',
                                            },
                                            { check: null, text: '' },
                                        ],
                                    },
                                ],
                            },
                        },
                    ],
                }),
            (error) => own(error, 'invalid-lyrics-file'),
        );
    });

    it('refuses a document whose lines break the model', () => {
        assert.throws(
            () =>
                exportToLyrics({
                    format: 'felyrics/lyrics',
                    version: 1,
                    lines: [
                        {
                            text: 'あ\n',
                            groups: {
                                ruby: [{ offset: 0, length: 1, pieces: [] }],
                            },
                        },
                    ],
                }),
            (error) => own(error, 'invalid-lyrics-file'),
        );
    });

    it('refuses text that is not JSON', () => {
        assert.throws(
            () => readExportJson('{ not json'),
            (error) => own(error, 'invalid-lyrics-file'),
        );
    });
});
