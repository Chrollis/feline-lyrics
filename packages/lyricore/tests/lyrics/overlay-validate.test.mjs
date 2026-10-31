import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editLineText } from '../../src/main/lyrics/interpolate.js';
import {
    spliceLine,
    textToLyricsLine,
    withOverlay,
} from '../../src/main/lyrics/line.js';
import {
    assertLyrics,
    isValidLyrics,
    textToLyrics,
} from '../../src/main/lyrics/lyrics.js';
import { emptyMeta } from '../../src/main/lyrics/meta.js';
import { mergeLines, splitLine } from '../../src/main/lyrics/structure.js';

function marker(offset, id) {
    return {
        id,
        kind: 'soft-break',
        anchor: { offset, length: 0 },
        content: null,
    };
}

function line(text, inserted = []) {
    return withOverlay(textToLyricsLine(text), { styles: [], inserted });
}

function documentOf(...lines) {
    return { meta: emptyMeta(), lines };
}

// A line the public API would have refused, built by hand: the only way to get
// one is to skip `withOverlay`, which is what an app does when it trusts JSON.
function unsound(text, overlay) {
    return { ...textToLyricsLine(text), overlay };
}

const OUT_OF_BODY = {
    styles: [{ offset: 9, length: 1, styleId: 'A' }],
    inserted: [],
};

describe('inserted object ids are unique per document', () => {
    it('rejects one id on two lines', () => {
        const lyrics = documentOf(
            line('ab\n', [marker(1, 'x')]),
            line('cd\n', [marker(1, 'x')]),
        );
        assert.equal(isValidLyrics(lyrics), false);
        assert.throws(
            () => assertLyrics(lyrics),
            (error) => {
                return (
                    error.code === 'invalid-inserted-object' &&
                    error.message.includes('"x"')
                );
            },
        );
    });

    it('accepts one id per line', () => {
        const lyrics = documentOf(
            line('ab\n', [marker(1, 'x')]),
            line('cd\n', [marker(1, 'y')]),
        );
        assert.equal(isValidLyrics(lyrics), true);
        assert.doesNotThrow(() => assertLyrics(lyrics));
    });

    it('accepts a document with no inserted objects at all', () => {
        assert.equal(isValidLyrics(textToLyrics('ab\ncd\n')), true);
    });

    it('refuses a document whose line carries an out-of-body overlay', () => {
        // `lyricsLineProblem` is blind to the overlay on purpose, so this is the
        // document validator's half of the job - and the gate the project reader
        // calls, which is why it must not pass an unsound overlay through.
        const lyrics = documentOf(unsound('abcd\n', OUT_OF_BODY));
        assert.equal(isValidLyrics(lyrics), false);
        assert.throws(
            () => assertLyrics(lyrics),
            (error) => {
                return (
                    error.code === 'invalid-style-run' &&
                    error.message.includes('line 0')
                );
            },
        );
    });
});

describe('every cell mutation validates the overlay it produces', () => {
    it('refuses to splice a line whose overlay is out of the body', () => {
        const bad = unsound('abcd\n', OUT_OF_BODY);
        assert.throws(
            () => spliceLine(bad, [1, 1], [{ text: 'z', span: null }]),
            (error) => error.code === 'invalid-style-run',
        );
    });

    it('refuses to split it', () => {
        const bad = unsound('abcd\n', OUT_OF_BODY);
        assert.throws(
            () => splitLine(bad, 2),
            (error) => error.code === 'invalid-style-run',
        );
    });

    it('refuses to merge into it', () => {
        const good = textToLyricsLine('ab\n');
        const bad = unsound('cd\n', OUT_OF_BODY);
        assert.throws(
            () => mergeLines(good, bad),
            (error) => error.code === 'invalid-style-run',
        );
    });

    it('refuses to type into it, because the fold path is a mutation too', () => {
        const lyrics = documentOf(unsound('abcd\n', OUT_OF_BODY));
        assert.throws(
            () => editLineText(lyrics, 0, [1, 1], 'z', null),
            (error) => error.code === 'invalid-style-run',
        );
    });
});
