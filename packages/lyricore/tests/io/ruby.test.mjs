import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    exportTagText,
    importTagText,
    joinReading,
    parseRubyLine,
    splitReading,
} from '../../src/main/index.js';

describe('@Ruby lines', () => {
    it('reads the four field shapes', () => {
        const plain = parseRubyLine('@Ruby1=亜,あ');
        assert.deepEqual(plain, {
            index: 1,
            parent: '亜',
            reading: 'あ',
            startField: '',
            endField: '',
        });
        const from = parseRubyLine('@Ruby2=亜,い,[00:04:00]');
        assert.equal(from?.startField, '[00:04:00]');
        assert.equal(from?.endField, '');
        const to = parseRubyLine('@Ruby3=亜,う,,[00:07:00]');
        assert.equal(to?.startField, '');
        assert.equal(to?.endField, '[00:07:00]');
        const both = parseRubyLine('@Ruby4=亜,え,[00:05:00],[00:07:00]');
        assert.equal(both?.startField, '[00:05:00]');
        assert.equal(both?.endField, '[00:07:00]');
    });

    it('leaves other lines alone', () => {
        assert.equal(parseRubyLine('@Title=歌'), null);
        assert.equal(parseRubyLine('[00:01:00]歌'), null);
        assert.equal(parseRubyLine('@Ruby1=only-parent'), null);
    });

    it('splits a reading into chunks at its inline offsets', () => {
        assert.deepEqual(splitReading('あし'), [
            { text: 'あし', offset: null },
        ]);
        assert.deepEqual(splitReading('か[00:00:50]わ'), [
            { text: 'か', offset: null },
            { text: '', offset: 500 },
            { text: 'わ', offset: null },
        ]);
        assert.equal(
            joinReading(splitReading('か[00:00:50]わ[00:01:00]せ')),
            'か[00:00:50]わ[00:01:00]せ',
        );
    });
});

describe('@Ruby into the model', () => {
    const SOURCE = [
        '[00:01:00]明日へ[00:03:00]',
        '@Ruby1=明日,あした',
        '',
    ].join('\n');

    it('turns an entry into a run over the parent text', () => {
        const { lyrics, losses } = importTagText(SOURCE);
        assert.deepEqual(losses, []);
        const runs = lyrics.lines[0]?.groups.ruby ?? [];
        assert.equal(runs.length, 2);
        const first = runs[0];
        assert.equal(first?.offset, 0);
        assert.equal(first?.length, 2);
        assert.equal(first?.pieces.length, 1);
        assert.equal(
            first?.pieces[0]?.text.cells.map((cell) => cell.text).join(''),
            'あした',
        );
    });

    it('places each inline offset as the next piece start', () => {
        const source = [
            '[00:01:00]明日へ[00:03:00]',
            '@Ruby1=明,あ[00:00:50]し',
            '',
        ].join('\n');
        const { lyrics } = importTagText(source);
        const run = lyrics.lines[0]?.groups.ruby?.[0];
        assert.equal(run?.pieces.length, 2);
        assert.deepEqual(run?.pieces[0]?.check, {
            time: 1_000,
            type: 'KeyDown',
        });
        assert.deepEqual(run?.pieces[1]?.check, {
            time: 1_500,
            type: 'KeyDown',
        });
    });

    it('honours the window when two occurrences compete', () => {
        const source = [
            '[00:01:00]愛と愛[00:04:00]',
            '@Ruby1=愛,あい,[00:01:00],[00:02:00]',
            '@Ruby2=愛,あ,[00:03:00],[00:04:00]',
            '',
        ].join('\n');
        const { lyrics } = importTagText(source);
        const runs = lyrics.lines[0]?.groups.ruby ?? [];
        assert.equal(runs.length, 3);
        assert.equal(runs[0]?.offset, 0);
        assert.equal(runs[1]?.offset, 2);
    });

    it('reports an entry that matches nothing', () => {
        const source = [
            '[00:01:00]明日へ[00:03:00]',
            '@Ruby1=昨日,きのう',
            '',
        ].join('\n');
        const { lyrics, losses } = importTagText(source);
        assert.equal(lyrics.lines[0]?.groups.ruby, undefined);
        assert.equal(losses.length, 1);
        assert.equal(losses[0]?.code, 'unsupported-construct');
    });
});

describe('@Ruby out of the model', () => {
    it('writes the parent, the reading and the window', () => {
        const source = [
            '[00:01:00]明日へ[00:03:00]',
            '@Ruby1=明日,あした',
            '',
        ].join('\n');
        const { lyrics } = importTagText(source);
        const { text } = exportTagText(lyrics);
        assert.equal(text.includes('@Ruby1=明日,あした,'), true);
        const round = importTagText(text);
        assert.deepEqual(round.losses, []);
        assert.equal(
            round.lyrics.lines[0]?.groups.ruby?.[0]?.pieces[0]?.text.cells[0]
                ?.text,
            'あ',
        );
    });

    it('reads back its own annotation when the parent span is zero length', () => {
        // Two chunks at one instant leave the parent with a zero-length span,
        // so the written window is a point. A half-open reader would reject it
        // and drop the reading on the way back in.
        const first = importTagText('[00:01:00]{明日|あした}[00:01:00]b\n');
        const { text } = exportTagText(first.lyrics);
        assert.equal(text.includes('[00:01:00],[00:01:00]'), true);
        const second = importTagText(text);
        assert.deepEqual(second.losses, []);
        const pieces = second.lyrics.lines[0]?.groups.ruby?.[0]?.pieces ?? [];
        assert.equal(
            pieces
                .flatMap((piece) => piece.text.cells.map((cell) => cell.text))
                .join(''),
            'あした',
        );
    });
});

describe('@Ruby windows and cancellation', () => {
    it('treats the end of the window as inclusive', () => {
        // The 2020 revision says the end is "at or before", so a parent that
        // starts exactly at the end still gets the reading.
        const source = '@Ruby1=亜,あ,,[00:02:00]\n[00:01:00]X[00:02:00]亜\n';
        const { lyrics, losses } = importTagText(source);
        assert.deepEqual(losses, []);
        const runs = lyrics.lines[0]?.groups.ruby ?? [];
        assert.equal(runs.length, 2);
        assert.equal(runs[0]?.offset, 1);
    });

    it('lets an entry with no reading cancel the ruby in its window', () => {
        // An empty reading is the spec's way of saying "no ruby here", and the
        // occurrence it covers must not be claimable by a later entry.
        const source = [
            '@Ruby1=亜,,[00:01:00],[00:03:00]',
            '@Ruby2=亜,あ',
            '[00:02:00]亜',
            '',
        ].join('\n');
        const { lyrics, losses } = importTagText(source);
        assert.equal(Object.hasOwn(lyrics.lines[0].groups, 'ruby'), false);
        assert.equal(losses.length, 1);
        assert.match(losses[0].detail, /no unclaimed occurrence/);
    });

    it('removes a comma a field cannot carry and says so', () => {
        // A comma separates the fields and the syntax has no escape, so the
        // only way to keep the line valid is to drop it — from the parent field
        // and from the body cell it covers, or the two stop matching.
        const { lyrics } = importTagText('[00:01:00]{亜,|あ}[00:03:00]x\n');
        const { text, losses } = exportTagText(lyrics);
        const line = text.split('\n').find((at) => at.startsWith('@Ruby1='));
        assert.equal(line.split(',').length, 4);
        const body = text.split('\n').find((at) => at.startsWith('['));
        assert.equal(body.includes(','), false);
        assert.equal(
            losses.some((entry) => entry.code === 'dropped-annotation'),
            true,
        );
    });

    it('keeps a comma no @Ruby parent covers', () => {
        // Outside an @Ruby parent the comma is ordinary text and survives.
        const { lyrics } = importTagText('[00:01:00]亜,[00:03:00]x\n');
        const { text, losses } = exportTagText(lyrics);
        assert.deepEqual(losses, []);
        assert.equal(
            text
                .split('\n')
                .find((at) => at.startsWith('['))
                .includes(','),
            true,
        );
    });
});
