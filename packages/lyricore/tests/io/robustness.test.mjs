import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { importLrc } from '../../src/main/io/lrc.js';
import { importTagText } from '../../src/main/io/tagtext.js';
import { isValidLyrics } from '../../src/main/lyrics/lyrics.js';

function codes(losses) {
    return losses.map((loss) => loss.code);
}

// Every case here crashed the importer or produced an invalid document before
// the fixes; each one must now either import a valid document or report a loss.
describe('imports that used to break', () => {
    it('adds the missing final break instead of throwing', () => {
        const imported = importTagText('[00:01:00]a');
        assert.equal(isValidLyrics(imported.lyrics), true);
        assert.deepEqual(codes(imported.losses), ['source-ignored']);
    });

    it('adds the missing final break even when no line has a tag', () => {
        const imported = importTagText('ab');
        assert.equal(isValidLyrics(imported.lyrics), true);
        assert.deepEqual(codes(imported.losses), ['source-ignored']);
    });

    it('splits on the line separators the model counts as breaks', () => {
        for (const separator of ['\u2028', '\u2029']) {
            const imported = importTagText(`[00:01:00]a${separator}`);
            assert.equal(isValidLyrics(imported.lyrics), true);
            assert.equal(imported.lyrics.lines.length, 1);
        }
    });

    it('lets two @Ruby lines with the same parent claim different places', () => {
        const imported = importTagText(
            '[00:01:00]abab\n@Ruby1=ab,x\n@Ruby2=ab,y\n',
        );
        assert.equal(isValidLyrics(imported.lyrics), true);
        const runs = imported.lyrics.lines[0].groups.ruby;
        assert.deepEqual(
            runs.map((run) => run.offset),
            [0, 2, 4],
        );
    });

    it('keeps a reading whose inline offset runs past its parent', () => {
        const imported = importTagText(
            '[00:01:00]xy\n@Ruby1=xy,[00:01:01]zz\n',
        );
        assert.equal(isValidLyrics(imported.lyrics), true);
    });

    it('reports rather than throws for every door', () => {
        for (const text of ['[00:01:00]a', 'ab', '[1:1]\u2029']) {
            assert.doesNotThrow(() => importTagText(text));
            assert.doesNotThrow(() => importLrc(text));
        }
    });
});
