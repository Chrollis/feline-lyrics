import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTag, formatTag, scanTags } from '../../src/main/io/tags.js';

describe('time tags', () => {
    it('reads the fraction as the unit its width claims', () => {
        assert.equal(parseTag('00:01:30'), 1_300);
        assert.equal(parseTag('00:01:05'), 1_050);
        assert.equal(parseTag('00:01:050'), 1_050);
        assert.equal(parseTag('00:01:5'), 1_500);
        assert.equal(parseTag('01:02:03'), 62_030);
    });

    it('rejects what the grammar does not allow', () => {
        assert.equal(parseTag('00:99:00'), null);
        assert.equal(parseTag('0:1:0:0'), null);
        assert.equal(parseTag('abc'), null);
        assert.equal(parseTag(''), null);
    });

    it('writes the form every reader accepts', () => {
        assert.equal(formatTag(1_300), '[00:01:30]');
        assert.equal(formatTag(62_030), '[01:02:03]');
        assert.equal(formatTag(0), '[00:00:00]');
    });
});

describe('scanning one line', () => {
    it('pairs each tag with the text that follows it', () => {
        const scanned = scanTags('[00:01:00]明[00:02:00]日へ', 'line');
        assert.deepEqual(
            scanned.chunks.map((chunk) => [chunk.time, chunk.text]),
            [
                [1_000, '明'],
                [2_000, '日へ'],
            ],
        );
        assert.equal(scanned.end, null);
    });

    it('keeps a trailing tag as the line end', () => {
        const scanned = scanTags('[00:01:00]明[00:02:00]', 'line');
        assert.equal(scanned.chunks.length, 1);
        assert.equal(scanned.end, 2_000);
    });

    it('leaves untagged text alone', () => {
        const scanned = scanTags('ただの文章', 'line');
        assert.deepEqual(
            scanned.chunks.map((chunk) => chunk.time),
            [null],
        );
    });

    it('never guesses a bracket it cannot read', () => {
        const scanned = scanTags('[00:01:00][99:99]x', 'line');
        assert.deepEqual(
            scanned.chunks.map((chunk) => chunk.text),
            ['[99:99]x'],
        );
        assert.equal(scanned.losses.length, 1);
        assert.equal(scanned.losses[0]?.code, 'tag-unrecognized');
    });
});

describe('RhythmicaLyrics extensions', () => {
    it('reads a check count in front of a time', () => {
        const scanned = scanTags('[2|00:01:00]明', 'line');
        assert.equal(scanned.chunks.length, 1);
        assert.equal(scanned.chunks[0].time, 1_000);
        assert.equal(scanned.chunks[0].checks, 2);
    });

    it('reads a check count with no time', () => {
        const scanned = scanTags('[3]明', 'line');
        assert.equal(scanned.chunks[0].time, null);
        assert.equal(scanned.chunks[0].checks, 3);
    });

    it('decodes a hex escape', () => {
        const scanned = scanTags('$3042です', 'line');
        assert.equal(scanned.chunks[0].text, 'あです');
    });

    it('drops the placeholder column', () => {
        const scanned = scanTags('[00:01:00]\u001a明', 'line');
        assert.equal(scanned.chunks[0].text, '明');
    });
});

describe('what scanning has to refuse', () => {
    it('keeps an unclosed bracket as text instead of guessing', () => {
        const scanned = scanTags('明[00:01', 'line');
        assert.equal(scanned.chunks.length, 1);
        assert.equal(scanned.chunks[0].text, '明[00:01');
        assert.equal(scanned.chunks[0].time, null);
    });

    it('rejects a count that cannot fit in a column', () => {
        const scanned = scanTags('[1234]x', 'line');
        assert.equal(scanned.chunks[0].text, '[1234]x');
        assert.deepEqual(
            scanned.losses.map((loss) => loss.code),
            ['tag-unrecognized'],
        );
    });

    it('rejects a count with no digits in front of the bar', () => {
        const scanned = scanTags('[|00:01:00]x', 'line');
        assert.equal(scanned.chunks[0].text, '[|00:01:00]x');
        assert.equal(scanned.losses.length, 1);
    });

    it('says so when a trailing check count has no text to belong to', () => {
        const scanned = scanTags('[2|00:01:00]明[3]', 'line');
        assert.deepEqual(
            scanned.chunks.map((chunk) => [
                chunk.time,
                chunk.text,
                chunk.checks,
            ]),
            [[1_000, '明', 2]],
        );
        assert.equal(scanned.end, null);
        assert.deepEqual(
            scanned.losses.map((loss) => loss.code),
            ['tag-unrecognized'],
        );
    });
});

describe('Enhanced LRC word timing', () => {
    it('reports it once and keeps the spelling as text', () => {
        const scanned = scanTags('[00:01:00]<00:01:50>He<00:01:90>llo', 'line');
        assert.equal(scanned.chunks[0]?.text, '<00:01:50>He<00:01:90>llo');
        assert.deepEqual(
            scanned.losses.map((loss) => loss.code),
            ['unsupported-construct'],
        );
        assert.equal(scanned.losses[0]?.at, 'line');
    });

    it('leaves angle brackets that are not word times alone', () => {
        const scanned = scanTags('a<b>c <3>', 'line');
        assert.deepEqual(scanned.losses, []);
        assert.equal(scanned.chunks[0]?.text, 'a<b>c <3>');
    });
});
