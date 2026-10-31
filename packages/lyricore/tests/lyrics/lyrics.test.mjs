import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LyricoreError } from '../../src/main/errors.js';
import { textToLyricsLine } from '../../src/main/lyrics/line.js';
import { emptyMeta } from '../../src/main/lyrics/meta.js';
import {
    assertLyrics,
    isValidLyrics,
    lyricsToText,
    textToLyrics,
} from '../../src/main/lyrics/lyrics.js';

describe('lyrics', () => {
    it('splits text into lines that each keep their line break', () => {
        const lyrics = textToLyrics('a\r\nb\n');

        assert.deepEqual(
            lyrics.lines.map((line) => line.baseStream.cells.length),
            [2, 2],
        );
        assert.equal(lyricsToText(lyrics), 'a\r\nb\n');
    });

    it('keeps an empty line as a line', () => {
        const lyrics = textToLyrics('a\n\n');

        assert.equal(lyrics.lines.length, 2);
        assert.equal(lyrics.lines[1].baseStream.cells.length, 1);
        assert.ok(isValidLyrics(lyrics));
    });

    it('refuses text that does not end with a line break', () => {
        assert.throws(() => textToLyrics('a\nb'), LyricoreError);
        assert.throws(() => textToLyrics('a\nb'), /line break/);
    });

    it('accepts an empty document', () => {
        const lyrics = textToLyrics('');

        assert.equal(lyrics.lines.length, 0);
        assert.ok(isValidLyrics(lyrics));
        assertLyrics(lyrics);
    });

    it('carries the metadata it was given', () => {
        const meta = { ...emptyMeta(), title: 'a', language: 'ja' };
        const lyrics = textToLyrics('a\n', meta);

        assert.deepEqual(lyrics.meta, meta);
        assert.ok(isValidLyrics(lyrics));
    });

    it('rejects a document whose metadata is invalid', () => {
        const typed = textToLyrics('a\n');
        const broken = { ...typed, meta: { ...typed.meta, offset: 1.5 } };

        assert.equal(isValidLyrics(broken), false);
        assert.throws(() => assertLyrics(broken), LyricoreError);
    });

    it('names the first invalid line by index', () => {
        const lyrics = textToLyrics('a\nb\n');
        const broken = {
            meta: emptyMeta(),
            lines: [
                lyrics.lines[0],
                textToLyricsLine('c\n'),
                {
                    baseStream: { cells: [] },
                    groups: {},
                    overlay: { styles: [], inserted: [] },
                },
            ],
        };

        assert.equal(isValidLyrics(broken), false);
        assert.throws(() => assertLyrics(broken), /line 2/);
    });

    it('round trips text through the model', () => {
        for (const text of ['', '\n', 'a\n', 'a\nb\n', '\u2028\n']) {
            assert.equal(lyricsToText(textToLyrics(text)), text);
        }
    });
});
