import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exportTagText, importTagText } from '../../src/main/index.js';

/**
 * The shape of a shipped NicoKaraMaker3 sample, trimmed: a leading spacer, one
 * tag per syllable, a blank line between verses, and `@Ruby` entries whose
 * readings carry their own relative times.
 */
const SAMPLE = [
    '[00:01:25]＿[00:02:95]兎[00:04:70]追[00:05:57]ひ[00:05:83]し[00:06:50]彼の[00:07:66]山',
    '[00:10:09]小[00:10:85]鮒[00:11:80]釣[00:12:71]り[00:13:01]し[00:13:63]彼の[00:14:84]川',
    '',
    '@Title=故郷',
    '@Artist=童謡',
    '',
    '@Ruby1=兎,う[00:00:75]さ[00:01:03]ぎ',
    '@Ruby2=追,お',
    '',
].join('\n');

describe('a shipped sample', () => {
    it('imports with nothing lost', () => {
        const { lyrics, losses } = importTagText(SAMPLE);
        assert.deepEqual(losses, []);
        assert.equal(lyrics.lines.length, 2);
        assert.equal(lyrics.meta.title, '故郷');
        assert.equal(lyrics.meta.artist, '童謡');
    });

    it('dates the syllables from the tags', () => {
        const { lyrics } = importTagText(SAMPLE);
        const spans = lyrics.lines[0].baseStream.cells.map(
            (cell) => cell.span?.start,
        );
        assert.deepEqual(spans.slice(0, 4), [1_250, 2_950, 4_700, 5_570]);
    });

    it('places both readings on the right cells', () => {
        const { lyrics } = importTagText(SAMPLE);
        const runs = lyrics.lines[0].groups.ruby ?? [];
        assert.deepEqual(
            runs.map((run) => [run.offset, run.length]),
            [
                [1, 1],
                [2, 1],
                [8, 1],
            ],
        );
        assert.equal(
            runs[0]?.pieces
                .map((piece) =>
                    piece.text.cells.map((cell) => cell.text).join(''),
                )
                .join(''),
            'うさぎ',
        );
    });

    it('survives a round trip', () => {
        const first = importTagText(SAMPLE);
        const text = exportTagText(first.lyrics).text;
        const second = importTagText(text);
        // The sample carries no stanza break, so the second pass must report
        // nothing either; the joiner's own blank lines are structural.
        assert.deepEqual(second.losses, []);
        assert.deepEqual(
            second.lyrics.lines.map((line) =>
                line.baseStream.cells.map((cell) => cell.span?.start ?? null),
            ),
            first.lyrics.lines.map((line) =>
                line.baseStream.cells.map((cell) => cell.span?.start ?? null),
            ),
        );
    });
});
