import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyMeta } from '../../src/main/index.js';
import { exportTagText, importTagText } from '../../src/main/index.js';
import { newLosses } from '../../src/main/io/loss.js';
import {
    formatHeaders,
    formatLrcHeaders,
    parseHeader,
    withHeader,
} from '../../src/main/io/headers.js';

describe('reading a header line', () => {
    it('tells the two spellings apart from a time tag', () => {
        assert.deepEqual(parseHeader('@Title=歌'), {
            key: 'Title',
            value: '歌',
            form: 'at',
        });
        assert.deepEqual(parseHeader('[ti:歌]'), {
            key: 'ti',
            value: '歌',
            form: 'bracket',
        });
        assert.equal(parseHeader('[00:01:00]'), null);
        assert.equal(parseHeader('ただの文章'), null);
        assert.equal(parseHeader('@'), null);
    });

    it('keeps an unknown key instead of guessing a field', () => {
        const header = parseHeader('@Emoji=♪,a.png,b.png');
        assert.equal(header?.key, 'Emoji');
        assert.equal(header?.value, '♪,a.png,b.png');
    });
});

describe('applying a header', () => {
    const losses = newLosses();
    const apply = (content) => {
        const header = parseHeader(content);
        return header === null
            ? emptyMeta()
            : withHeader(emptyMeta(), header, 'line', losses);
    };

    it('maps both spellings onto one field', () => {
        assert.equal(apply('@Title=歌').title, '歌');
        assert.equal(apply('[ti:歌]').title, '歌');
        assert.equal(apply('@Lyrics=作詞者').lyricist, '作詞者');
        assert.equal(apply('[lr:作詞者]').lyricist, '作詞者');
        assert.equal(apply('@TITLE=歌').title, '歌');
    });

    it('reads the offset as a time and reports one it cannot use', () => {
        assert.equal(apply('@Offset=-250').offset, -250);
        assert.equal(apply('[offset:300]').offset, 300);
        const before = losses.losses.length;
        assert.equal(apply('@Offset=soon').offset, 0);
        assert.equal(losses.losses.length, before + 1);
        assert.equal(losses.losses.at(-1)?.code, 'meta-unsupported');
    });

    it('parks everything it has no field for in extra', () => {
        const meta = apply('@Emoji=♪,a.png');
        assert.deepEqual(meta.extra, { Emoji: '♪,a.png' });
    });
});

describe('writing headers back', () => {
    it('writes the time-tag block in a stable order', () => {
        const meta = {
            ...emptyMeta(),
            title: '歌',
            artist: '人',
            offset: -250,
            extra: { Emoji: '♪,a.png' },
        };
        assert.deepEqual(formatHeaders(meta), [
            '@Title=歌',
            '@Artist=人',
            '@Offset=-250',
            '@Emoji=♪,a.png',
        ]);
    });

    it('writes nothing for an empty meta', () => {
        assert.deepEqual(formatHeaders(emptyMeta()), []);
    });

    it('writes the LRC block with its own keys', () => {
        const meta = {
            ...emptyMeta(),
            title: '歌',
            lyricist: '作詞者',
            offset: 5,
        };
        assert.deepEqual(formatLrcHeaders(meta), [
            '[ti:歌]',
            '[lr:作詞者]',
            '[offset:5]',
        ]);
    });
});

describe('headers through the file doors', () => {
    it('carries metadata in and back out', () => {
        const source = [
            '@Title=歌',
            '@Artist=人',
            '[00:01:00]明[00:02:00]',
            '',
        ].join('\n');
        const first = importTagText(source);
        assert.equal(first.lyrics.meta.title, '歌');
        assert.equal(first.lyrics.meta.artist, '人');
        assert.deepEqual(first.losses, []);

        const written = exportTagText(first.lyrics).text;
        assert.equal(written.startsWith('@Title=歌\n@Artist=人\n'), true);
        assert.equal(importTagText(written).lyrics.meta.title, '歌');
    });

    it('keeps a construct it has no field for in extra', () => {
        const source = ['@Emoji=♪,a.png', '[00:01:00]明[00:02:00]', ''].join(
            '\n',
        );
        const first = importTagText(source);
        assert.deepEqual(first.lyrics.meta.extra, { Emoji: '♪,a.png' });
        assert.equal(
            exportTagText(first.lyrics).text.includes('@Emoji=♪,a.png'),
            true,
        );
    });
});
