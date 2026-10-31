import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyMeta, isValidMeta } from '../../src/main/lyrics/meta.js';
import { assertLyrics } from '../../src/main/lyrics/lyrics.js';
import { TIME_MAX } from '../../src/main/lyrics/time.js';

describe('lyrics meta', () => {
    it('starts empty but valid', () => {
        const meta = emptyMeta();

        assert.equal(meta.title, '');
        assert.equal(meta.offset, 0);
        assert.deepEqual(meta.extra, {});
        assert.ok(isValidMeta(meta));
    });

    it('holds song, tagging, file and language facts', () => {
        const meta = {
            ...emptyMeta(),
            title: 'a',
            artist: 'b',
            taggingBy: 'c',
            renderer: 'lyricore',
            language: 'ja',
        };

        assert.ok(isValidMeta(meta));
        assert.equal(meta.language, 'ja');
    });

    it('accepts any int32 offset and rejects anything else', () => {
        assert.ok(isValidMeta({ ...emptyMeta(), offset: TIME_MAX }));
        assert.ok(isValidMeta({ ...emptyMeta(), offset: -1 }));
        assert.equal(isValidMeta({ ...emptyMeta(), offset: 1.5 }), false);
        assert.equal(
            isValidMeta({ ...emptyMeta(), offset: TIME_MAX + 1 }),
            false,
        );
    });

    it('keeps unknown tags, but only as strings', () => {
        assert.ok(isValidMeta({ ...emptyMeta(), extra: { bgfile: 'x.png' } }));
        assert.equal(isValidMeta({ ...emptyMeta(), extra: { bad: 1 } }), false);
    });

    it('rejects an array of extra tags', () => {
        // The reader only accepts an object here, so an array that passed
        // validation would write a project the reader refuses to load.
        assert.equal(isValidMeta({ ...emptyMeta(), extra: ['x'] }), false);
    });

    it('answers false when extra is missing or not an object', () => {
        const missing = { ...emptyMeta() };
        delete missing.extra;

        assert.equal(isValidMeta(missing), false);
        assert.equal(isValidMeta({ ...emptyMeta(), extra: null }), false);
        assert.equal(isValidMeta({ ...emptyMeta(), extra: 'x' }), false);
    });

    it('reports metadata problems through the metadata code', () => {
        const lyrics = { meta: { ...emptyMeta(), offset: 1.5 }, lines: [] };

        let caught = null;
        try {
            assertLyrics(lyrics);
        } catch (error) {
            caught = error;
        }

        assert.equal(caught?.code, 'invalid-lyrics-meta');
    });
});
