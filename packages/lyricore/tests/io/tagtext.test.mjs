import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exportTagText, importTagText } from '../../src/main/io/tagtext.ts';

const SAMPLE =
    '[00:01:00]故郷 [00:02:19](1 [00:03:71]の[00:05:00]\n' +
    '[00:06:00]平[00:08:00]\n';

describe('time-tagged import', () => {
    it('turns each tagged chunk into a run of the default group', () => {
        const { lyrics, losses } = importTagText(SAMPLE);
        assert.equal(lyrics.lines.length, 2);
        assert.deepEqual(losses, []);
        const runs = lyrics.lines[0].groups.default;
        assert.deepEqual(
            runs?.map((run) => [run.offset, run.length]),
            [
                [0, 3],
                [3, 3],
                [6, 1],
                [7, 1],
            ],
        );
    });

    it('fills the cells from the checks with the editor rules', () => {
        const { lyrics } = importTagText(SAMPLE);
        const cells = lyrics.lines[0].baseStream.cells;
        assert.equal(cells[0]?.span?.start, 1_000);
        assert.equal(cells[3]?.span?.start, 2_190);
        assert.equal(cells[6]?.span?.start, 3_710);
        // The terminal cell starts at the end tag; its length runs to the next
        // line's first cell, because that is what the cross-line rule says.
        assert.deepEqual(cells[7]?.span, { start: 5_000, duration: 1_000 });
    });

    it('reads a whole line of plain text when there are no tags', () => {
        const { lyrics, losses } = importTagText('ただの歌詞\n');
        assert.equal(lyrics.lines.length, 1);
        assert.equal(losses.length, 0);
        const cells = lyrics.lines[0].baseStream.cells;
        assert.equal(
            cells.every((cell) => cell.span === null),
            true,
        );
    });
});

describe('time-tagged export', () => {
    it('round-trips what it imported', () => {
        const imported = importTagText(SAMPLE);
        const exported = exportTagText(imported.lyrics);
        assert.equal(exported.text, SAMPLE);
        assert.deepEqual(exported.losses, []);
    });

    it('writes a plain line without tags', () => {
        const { lyrics } = importTagText('ただの歌詞\n');
        const exported = exportTagText(lyrics);
        assert.equal(exported.text, 'ただの歌詞\n');
        assert.deepEqual(exported.losses, []);
    });

    it('reads a check count of 10 as a key-up and never writes one back', () => {
        const { lyrics, losses } = importTagText('[10|00:01:00]明\n');
        assert.deepEqual(losses, []);

        const runs = lyrics.lines[0].groups.default ?? [];
        assert.equal(runs[0]?.pieces.length, 1);
        assert.deepEqual(runs[0]?.pieces[0]?.check, {
            time: 1_000,
            type: 'KeyUp',
        });

        const exported = exportTagText(lyrics);
        assert.ok(!exported.text.includes('[10|'));
        assert.deepEqual(importTagText(exported.text).losses, []);
    });

    it('reports the key-up it cannot write', () => {
        const { lyrics } = importTagText('[10|00:01:00]明\n');
        const exported = exportTagText(lyrics);
        assert.ok(
            exported.losses.some((loss) => loss.code === 'dropped-check-kind'),
        );
    });
});
