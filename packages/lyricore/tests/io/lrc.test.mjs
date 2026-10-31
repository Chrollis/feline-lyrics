import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exportLrc, importLrc, importTagText } from '../../src/main/index.js';

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

    it('reports text that would read back as a tag or an escape', () => {
        const escaped = importLrc('[00:01:00]a$005B0:05$005Db\n').lyrics;
        const codes = exportLrc(escaped).losses.map((loss) => loss.code);
        assert.equal(codes.includes('unsupported-construct'), true);

        const plain = importLrc('[00:01:00]a[b]c\n').lyrics;
        assert.deepEqual(exportLrc(plain).losses, []);
    });

    it('writes a recorded end on the last line and leaves a made-up one out', () => {
        // A bare tag is how a line end is spelled, so an end the document
        // really holds has to be written; the end the reader invents for a
        // closing line (its last check plus five seconds) does not.
        const recorded = importLrc('[00:01:00]aaa\n[00:02:00]bbb[00:04:50]\n');
        assert.equal(
            exportLrc(recorded.lyrics).text,
            '[00:01:00]aaa\n[00:02:00]bbb[00:04:50]\n',
        );
        const madeUp = importLrc('[00:01:00]aaa\n[00:02:00]bbb\n');
        assert.equal(
            exportLrc(madeUp.lyrics).text,
            '[00:01:00]aaa\n[00:02:00]bbb\n',
        );
        // And the end the first file recorded is still there after a round trip.
        const written = exportLrc(recorded.lyrics).text;
        assert.equal(exportLrc(importLrc(written).lyrics).text, written);
    });

    it('dates the invented end from the one tag the line becomes', () => {
        // The export writes a single tag per line, so whoever reads the export
        // invents its end from that tag, not from the last chunk the document
        // still holds. Two chunks start at 1000 and 2000: the end (7000) is not
        // the invented one (6000), so it has to be written or it is lost.
        const { lyrics } = importLrc('[00:01:00]ab[00:02:00]cd\n');
        const end = lyrics.lines[0]?.baseStream.cells.at(-1)?.span?.start;
        assert.equal(end, 7000);
        const written = exportLrc(lyrics).text;
        assert.equal(written, '[00:01:00]abcd[00:07:00]\n');
        const back = importLrc(written).lyrics;
        assert.equal(back.lines[0]?.baseStream.cells.at(-1)?.span?.start, 7000);
        assert.equal(exportLrc(back).text, written);
    });
});

describe('LRC text the reader would eat', () => {
    it('reports a line whose whole text is a count tag', () => {
        // `[3]` is a count tag to the scanner, so it leaves no chunk behind and
        // a test that looks at the shape of the split calls the body plain. It
        // reads back as no text at all, so the export has to say so.
        const { lyrics } = importTagText('[00:01:00]$005B3]\n');
        const exported = exportLrc(lyrics);
        assert.deepEqual(
            exported.losses.map((loss) => loss.code),
            ['unsupported-construct'],
        );
        // The text is still written; the loss is the warning that it will not
        // survive the next read.
        assert.ok(exported.text.includes('[3]'));
        assert.equal(
            importLrc(exported.text).lyrics.lines[0]?.baseStream.cells.length,
            1,
        );
    });
});
