import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exportLrc } from '../../src/main/io/lrc.js';
import { importTagText } from '../../src/main/io/tagtext.js';

/** Every cell's span as `[start, duration]`, or null when it is untimed. */
function spans(line) {
    return line.baseStream.cells.map((cell) =>
        cell.span === null ? null : [cell.span.start, cell.span.duration],
    );
}

describe('a tagged line always gets its time', () => {
    it('times both lines when two lines share an instant', () => {
        const { lyrics, losses } = importTagText('[00:01:00]a\n[00:01:00]b\n');
        assert.deepEqual(losses, []);
        // The second line starts at the same instant, so the first line's
        // interval is empty rather than missing.
        assert.deepEqual(spans(lyrics.lines[0]), [
            [1_000, 0],
            [1_000, 500],
        ]);
        assert.deepEqual(spans(lyrics.lines[1]), [
            [1_000, 5_000],
            [6_000, 500],
        ]);
        const exported = exportLrc(lyrics);
        assert.equal(exported.text, '[00:01:00]a\n[00:01:00]b\n');
        assert.deepEqual(exported.losses, []);
    });

    it('times every equal-time line, not only the last', () => {
        const { lyrics, losses } = importTagText(
            '[00:01:00]a\n[00:02:00]b\n[00:02:00]c\n[00:03:00]d\n',
        );
        assert.deepEqual(losses, []);
        assert.deepEqual(lyrics.lines.map(spans), [
            [
                [1_000, 1_000],
                [2_000, 500],
            ],
            [
                [2_000, 0],
                [2_000, 500],
            ],
            [
                [2_000, 1_000],
                [3_000, 500],
            ],
            [
                // Nothing dates the closing line, so it holds for the default
                // five seconds rather than the usual 500 ms tail.
                [3_000, 5_000],
                [8_000, 500],
            ],
        ]);
        assert.deepEqual(exportLrc(lyrics).losses, []);
    });

    it('never ends a line before it starts', () => {
        const { lyrics, losses } = importTagText('[00:02:00]b\n[00:01:00]a\n');
        assert.deepEqual(losses, []);
        assert.deepEqual(spans(lyrics.lines[0]), [
            [2_000, 0],
            [2_000, 500],
        ]);
        // A tail equal to the line's own start says nothing the reader does not
        // already know, and a repeated timestamp reads as a zero-length entry in
        // many players, so it is left out.
        assert.equal(exportLrc(lyrics).text, '[00:02:00]b\n[00:01:00]a\n');
    });

    it('keeps a leading untimed chunk without claiming the line is untimed', () => {
        const { lyrics, losses } = importTagText(
            '「[00:39:99]バ[00:40:10]イ\n',
        );
        assert.deepEqual(losses, []);
        // Nothing dates the opening bracket, and nothing pretends to.
        assert.equal(spans(lyrics.lines[0])[0], null);
    });

    it('does not report an untagged line as a lost tag', () => {
        const { losses } = importTagText('hello\n[00:01:00]a\n');
        assert.deepEqual(losses, []);
    });
});
