import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { importPlainText } from '../../src/main/io/plain.js';
import { exportPlainText } from '../../src/main/io/plain.js';
import { textToLyricsLine } from '../../src/main/lyrics/line.js';
import { emptyMeta } from '../../src/main/lyrics/meta.js';

function codes(losses) {
    return losses.map((loss) => loss.code);
}

describe('plain text', () => {
    it('reads every line as one line with nothing timed', () => {
        const imported = importPlainText('明\n日\n');
        assert.equal(imported.lyrics.lines.length, 2);
        assert.deepEqual(
            imported.lyrics.lines.map((line) =>
                line.baseStream.cells.map((cell) => cell.text),
            ),
            [
                ['明', '\n'],
                ['日', '\n'],
            ],
        );
        assert.deepEqual(
            imported.lyrics.lines.flatMap((line) =>
                line.baseStream.cells.map((cell) => cell.span),
            ),
            [null, null, null, null],
        );
        assert.deepEqual(imported.losses, []);
    });

    it('adds the missing line break and says so', () => {
        const imported = importPlainText('明');
        assert.deepEqual(codes(imported.losses), ['source-ignored']);
        assert.equal(imported.losses[0].at, 'file');
    });

    it('writes the text back and reports what text cannot carry', () => {
        const timed = textToLyricsLine('明\n');
        const lyrics = {
            meta: { ...emptyMeta(), title: 'Song' },
            lines: [
                {
                    ...timed,
                    baseStream: {
                        cells: [
                            {
                                text: '明',
                                span: { start: 1_000, duration: 500 },
                            },
                            {
                                text: '\n',
                                span: { start: 1_500, duration: 500 },
                            },
                        ],
                    },
                    groups: {
                        ruby: [
                            {
                                offset: 0,
                                length: 1,
                                pieces: [{ check: null, text: { cells: [] } }],
                            },
                        ],
                    },
                },
            ],
        };
        const exported = exportPlainText(lyrics);
        assert.equal(exported.text, '明\n');
        assert.deepEqual(codes(exported.losses).sort(), [
            'dropped-annotation',
            'meta-unsupported',
            'source-ignored',
        ]);
    });

    it('is stable through a second round', () => {
        const first = exportPlainText(importPlainText('明\n日\n').lyrics);
        assert.equal(first.text, '明\n日\n');
        const second = exportPlainText(importPlainText(first.text).lyrics);
        assert.equal(second.text, first.text);
    });
});
