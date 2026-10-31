import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { importTagText } from '../../src/main/index.js';

describe('inline ruby {parent|reading}', () => {
    it('moves the reading into a run and keeps the parent as lyric text', () => {
        const { lyrics, losses } = importTagText(
            '[00:01:00]{明日|あした}へ[00:03:00]\n',
        );
        assert.deepEqual(losses, []);
        const line = lyrics.lines[0];
        assert.equal(
            line.baseStream.cells.map((cell) => cell.text).join(''),
            '明日へ\n',
        );
        const run = line.groups.ruby?.[0];
        assert.equal(run?.offset, 0);
        assert.equal(run?.length, 2);
        assert.equal(
            run?.pieces[0]?.text.cells.map((cell) => cell.text).join(''),
            'あした',
        );
    });

    it('places a run after a time tag that came first', () => {
        const { lyrics } = importTagText('[00:01:00]君と{明日|あした}\n');
        const run = lyrics.lines[0]?.groups.ruby?.[0];
        assert.equal(run?.offset, 2);
        assert.equal(run?.length, 2);
    });

    it('leaves a line without braces alone', () => {
        const { lyrics } = importTagText('[00:01:00]明日へ\n');
        assert.equal(lyrics.lines[0]?.groups.ruby, undefined);
    });

    it('turns inline reading times into piece checks', () => {
        const { lyrics, losses } = importTagText(
            '[00:01:00]{明日|あ[00:00:50]した}\n',
        );
        assert.deepEqual(losses, []);
        const run = lyrics.lines[0]?.groups.ruby?.[0];
        assert.equal(run?.length, 2);
        assert.deepEqual(
            run?.pieces.map((piece) => piece.check),
            [
                { time: 1000, type: 'KeyDown' },
                { time: 1500, type: 'KeyDown' },
            ],
        );
    });

    it('cannot offset a reading whose parent never starts', () => {
        const { lyrics, losses } = importTagText('{明日|あ[00:00:50]した}\n');
        assert.equal(lyrics.lines[0]?.groups.ruby?.[0]?.length, 2);
        assert.equal(
            losses.some((loss) => loss.code === 'dropped-check-times'),
            true,
        );
    });

    it('extends the run by one cell per continuation mark', () => {
        const { lyrics, losses } = importTagText('[00:01:00]{貴|あなた＋}女\n');
        assert.deepEqual(losses, []);
        const run = lyrics.lines[0]?.groups.ruby?.[0];
        assert.equal(run?.offset, 0);
        assert.equal(run?.length, 2);
        assert.equal(
            run?.pieces[0]?.text.cells.map((cell) => cell.text).join(''),
            'あなた',
        );
    });

    it('counts a continuation past a multi-cell parent', () => {
        const { lyrics, losses } = importTagText('[00:01:00]{明日|あし＋}へ\n');
        assert.deepEqual(losses, []);
        const run = lyrics.lines[0]?.groups.ruby?.[0];
        assert.equal(run?.offset, 0);
        assert.equal(run?.length, 3);
    });

    it('stops a continuation at the line break', () => {
        const { lyrics, losses } = importTagText('[00:01:00]{貴|あなた＋＋}\n');
        const run = lyrics.lines[0]?.groups.ruby?.[0];
        assert.equal(run?.length, 1);
        assert.equal(
            losses.some((loss) => loss.code === 'collapsed-run'),
            true,
        );
    });

    it('keeps a continuation out of the next annotation', () => {
        // A `＋` grows the run by one column, and the column that follows may
        // already belong to the next `{...}`. One cell cannot hold two runs,
        // so the continuation gives way and the loss is recorded.
        for (const text of [
            '[00:03:00]{明|明＋}{い|あ}\n',
            '[00:03:00]{明|明＋あ}{い|あ}\n',
            '[00:03:00]{明|明＋＋}{い|あ}\n',
        ]) {
            const { lyrics, losses } = importTagText(text);
            const runs = lyrics.lines[0]?.groups.ruby ?? [];
            assert.deepEqual(
                runs.map((run) => [run.offset, run.length]),
                [
                    [0, 1],
                    [1, 1],
                    [2, 1],
                ],
                text,
            );
            assert.equal(
                losses.some((loss) => loss.code === 'collapsed-run'),
                true,
                text,
            );
        }
    });
});
