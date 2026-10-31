import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    decodeText,
    encodeText,
    joinLines,
    splitLines,
} from '../../src/main/io/text.ts';

describe('text', () => {
    it('strips a BOM and names the encoding', () => {
        const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x62);
        const decoded = decodeText(bytes);
        assert.equal(decoded.text, 'ab');
        assert.equal(decoded.encoding, 'utf-8');
    });

    it('reads UTF-16LE through its BOM', () => {
        const bytes = encodeText('故郷', 'utf-16le');
        const decoded = decodeText(bytes);
        assert.equal(decoded.text, '故郷');
        assert.equal(decoded.encoding, 'utf-16le');
    });

    it('reports a BOM that does not decode cleanly', () => {
        // A UTF-8 BOM in front of bytes that are not UTF-8.
        const wrong = decodeText(Uint8Array.of(0xef, 0xbb, 0xbf, 0xff, 0x81));
        assert.equal(wrong.encoding, 'utf-8');
        assert.equal(wrong.text, '\ufffd\ufffd');
        assert.equal(wrong.losses.length, 1);
        assert.equal(wrong.losses[0].code, 'source-ignored');

        // A UTF-16LE BOM followed by half a code unit: the decoder reports one
        // replacement for the incomplete unit.
        const truncated = decodeText(Uint8Array.of(0xff, 0xfe, 0x61));
        assert.equal(truncated.encoding, 'utf-16le');
        assert.equal(truncated.text, '\ufffd');
        assert.equal(truncated.losses.length, 1);
        assert.equal(truncated.losses[0].code, 'source-ignored');
    });

    it('keeps plain ASCII as UTF-8', () => {
        const decoded = decodeText(
            new TextEncoder().encode('[00:01:00]la la\n'),
        );
        assert.equal(decoded.encoding, 'utf-8');
    });

    it('reads Shift_JIS lyrics', () => {
        // 【波】 in Shift_JIS, taken from a NicoKaraMaker3 sample.
        const bytes = Uint8Array.of(0x81, 0x79, 0x94, 0x67, 0x81, 0x7a);
        const decoded = decodeText(bytes);
        assert.equal(decoded.text, '【波】');
        assert.equal(decoded.encoding, 'shift_jis');
    });

    it('reads GB18030 lyrics', () => {
        // 故乡 in GB18030, the shape a Chinese .lrc usually takes.
        const bytes = Uint8Array.of(0xb9, 0xca, 0xcf, 0xe7);
        const decoded = decodeText(bytes);
        assert.equal(decoded.text, '故乡');
        assert.equal(decoded.encoding, 'gb18030');
    });

    it('falls back to a lossy read only when nothing decodes', () => {
        // 0xFF then 0x81 is invalid in every code page we try.
        const decoded = decodeText(Uint8Array.of(0xff, 0x81));
        assert.equal(decoded.encoding, 'utf-8');
        assert.equal(decoded.losses.length, 1);
        assert.equal(decoded.losses[0].code, 'source-ignored');
    });

    it('splits lines and keeps the break that ended each one', () => {
        const lines = splitLines('a\r\nb\rc\nd');
        assert.deepEqual(lines, [
            { content: 'a', break: '\r\n' },
            { content: 'b', break: '\r' },
            { content: 'c', break: '\n' },
            { content: 'd', break: '' },
        ]);
    });

    it('joins what it split', () => {
        const text = 'a\r\nb\rc\nd';
        assert.equal(joinLines(splitLines(text)), text);
    });
});
