import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exportLrc, importLrc } from '../../src/main/index.js';

const SOURCE = [
    '[ti:歌]',
    '[ar:人]',
    '[00:01:00]明日へ',
    '[00:03:00]君と',
    '',
].join('\n');

describe('LRC in', () => {
    it('reads headers and one tag per line', () => {
        const { lyrics, losses } = importLrc(SOURCE);
        assert.deepEqual(losses, []);
        assert.equal(lyrics.meta.title, '歌');
        assert.equal(lyrics.meta.artist, '人');
        assert.equal(lyrics.lines.length, 2);
        assert.deepEqual(
            lyrics.lines.map((line) => line.baseStream.cells[0].span?.start),
            [1_000, 3_000],
        );
    });

    it('reads a word-level file as several runs of one line', () => {
        const source = ['[00:01:00]明[00:02:00]日へ[00:03:00]', ''].join('\n');
        const { lyrics } = importLrc(source);
        const runs = lyrics.lines[0].groups.default;
        assert.equal(runs.length, 3);
        assert.deepEqual(
            runs.map((run) => run.offset),
            [0, 1, 3],
        );
    });
});

describe('LRC out', () => {
    it('writes headers and one tag per line', () => {
        const { lyrics } = importLrc(SOURCE);
        const { text, losses } = exportLrc(lyrics);
        assert.equal(
            text,
            '[ti:歌]\n[ar:人]\n[00:01:00]明日へ\n[00:03:00]君と\n',
        );
        assert.deepEqual(losses, []);
    });

    it('reports what a line-level format cannot carry', () => {
        const source = [
            '[00:01:00]明日へ[00:03:00]',
            '',
            '@Ruby1=明日,あした',
            '',
        ].join('\n');
        const { lyrics } = importLrc(source);
        const { losses } = exportLrc(lyrics);
        const codes = losses.map((loss) => loss.code);
        assert.equal(codes.includes('dropped-annotation'), true);
    });

    it('survives a round trip of what it can carry', () => {
        const first = importLrc(SOURCE);
        const written = exportLrc(first.lyrics).text;
        const second = importLrc(written);
        assert.deepEqual(
            second.lyrics.lines.map(
                (line) => line.baseStream.cells[0].span?.start,
            ),
            first.lyrics.lines.map(
                (line) => line.baseStream.cells[0].span?.start,
            ),
        );
        assert.equal(second.lyrics.meta.title, '歌');
    });
});
