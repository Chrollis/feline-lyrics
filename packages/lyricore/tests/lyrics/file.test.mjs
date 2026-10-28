import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    fileToLyrics,
    jsonToLyrics,
    lyricsToFile,
    lyricsToJson,
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
            },
        ],
    };
}

function own(error, code) {
    return error instanceof Error && error.code === code;
}

describe('the lyrics file', () => {
    it('round trips a timed document without changing anything', () => {
        const before = timed();
        const after = fileToLyrics(lyricsToFile(before));
        assert.deepEqual(after, before);
    });

    it('round trips through JSON text', () => {
        const before = timed();
        assert.deepEqual(jsonToLyrics(lyricsToJson(before)), before);
        assert.equal(lyricsToJson(before).endsWith('\n'), true);
    });

    it('writes only the metadata it has and reads the empty values back', () => {
        const file = lyricsToFile({
            meta: { ...emptyMeta(), title: 'Song' },
            lines: [],
        });
        assert.deepEqual(file.meta, { title: 'Song' });
        const back = fileToLyrics(file);
        assert.deepEqual(back.meta, { ...emptyMeta(), title: 'Song' });
    });

    it('leaves the groups out when a line has no annotation', () => {
        const file = lyricsToFile({
            meta: emptyMeta(),
            lines: [
                { baseStream: stream([cell('あ'), cell('\n')]), groups: {} },
            ],
        });
        assert.equal(file.lines[0].groups, undefined);
        assert.deepEqual(file.lines[0].spans, [null, null]);
    });

    it('reads every cell as untimed when the spans are not written', () => {
        const back = fileToLyrics({
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
                fileToLyrics({ format: 'other/thing', version: 1, lines: [] }),
            (error) => own(error, 'invalid-lyrics-file'),
        );
        assert.throws(
            () =>
                fileToLyrics({
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
                fileToLyrics({
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
                fileToLyrics({
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
                fileToLyrics({
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
            () => jsonToLyrics('{ not json'),
            (error) => own(error, 'invalid-lyrics-file'),
        );
    });
});
