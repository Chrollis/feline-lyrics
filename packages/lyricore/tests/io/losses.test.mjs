import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { importTagText } from '../../src/main/io/tagtext.js';

/** The loss details a conversion reported, for matching without the `at`. */
function details(result) {
    return result.losses.map((loss) => loss.detail);
}

describe('nothing is lost silently', () => {
    it('reports a 0x1A placeholder column it drops', () => {
        const result = importTagText('[00:01:00]a\u001ab\n');
        assert.equal(
            result.lyrics.lines[0].baseStream.cells
                .map((cell) => cell.text)
                .join(''),
            'ab\n',
        );
        assert.deepEqual(details(result), [
            'a 0x1A placeholder column was dropped: the model has no placeholder cell',
        ]);
    });

    it('reports a @Ruby line that carries no reading, and keeps its bytes', () => {
        const result = importTagText('[00:01:00]a\n@Ruby1=\n');
        assert.equal(result.losses.length, 1);
        assert.match(result.losses[0]?.detail ?? '', /has no "TT,RR" payload/);
        assert.equal(result.lyrics.meta.extra.Ruby1, '');
    });

    it('reports dropped stanza breaks instead of hiding them', () => {
        const result = importTagText('[00:01:00]a\n\n[00:02:00]b\n');
        assert.equal(result.lyrics.lines.length, 2);
        // The model has no line gap, so the break is content that did not
        // survive; the count is aggregated into one report per file.
        assert.deepEqual(details(result), [
            '1 stanza break(s) dropped; the model has no line gap',
        ]);
    });

    it('does not report the separator before the @Ruby block', () => {
        const result = importTagText('[00:01:00]a\n\n@Ruby1=a,えー\n');
        assert.deepEqual(result.losses, []);
    });

    it('does not report a blank with no lyric on one side of it', () => {
        // A leading blank and the header/body separator are structural; only a
        // blank between two lyric lines is a stanza break the model drops.
        const leading = importTagText('\n[00:01:00]a\n');
        assert.deepEqual(details(leading), []);
        const header = importTagText('@Title=t\n@Artist=m\n\n[00:01:00]a\n');
        assert.deepEqual(details(header), []);
        const trailing = importTagText('[00:01:00]a\n\n');
        assert.deepEqual(details(trailing), []);
    });

    it('keeps a nested brace construct as text and says so', () => {
        const result = importTagText('[00:01:00]{a{b|c}d|y}\n');
        assert.equal(
            result.lyrics.lines[0].baseStream.cells
                .map((cell) => cell.text)
                .join(''),
            '{a{b|c}d|y}\n',
        );
        assert.equal(result.lyrics.lines[0].groups.ruby, undefined);
        assert.equal(result.losses.length, 1);
        assert.match(result.losses[0]?.detail ?? '', /contain another "\{"/);
    });
});
