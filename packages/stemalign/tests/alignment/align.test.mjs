import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { align, clampWindowWords } from '../../src/main/alignment/align.js';

const AUDIO = { sampleRate: 16000, channels: [new Float32Array(16000)] };

function handle(sessions) {
    return {
        id: 'whisper-base',
        sessions,
        settings: {},
        release() {
            // The aligner does not own the handle; nothing to release here.
        },
    };
}

describe('align', () => {
    it('rejects a handle that carries no encoder session', async () => {
        await assert.rejects(
            align(AUDIO, 'hello', handle(new Map())),
            (error) => error.code === 'model-invalid',
        );

        console.log('a model handle is inspected before any audio is decoded');
    });
});

/** A timing shaped like an align word, with a throwaway token list. */
function word(text, start, end) {
    return { word: text, tokens: [1], start, end, probability: 0 };
}

function spans(words) {
    return words.map(({ word: text, start, end }) => ({ text, start, end }));
}

describe('clampWindowWords', () => {
    it('folds the trailing word into the last window before clamping', () => {
        // The last window produced two words and rescued a third one after it
        // recorded its range: the clamp has to treat that word as the last word
        // of the window instead of skipping it.
        const clamped = clampWindowWords(
            [word('a', 0, 1), word('b', 1, 2)],
            [[0, 2]],
            word('c', 2, 9),
            { maxDur: 2, mediumFactor: false },
        );

        assert.deepEqual(spans(clamped), [
            { text: 'a', start: 0, end: 1 },
            { text: 'b', start: 1, end: 2 },
            { text: 'c', start: 2, end: 4 },
        ]);

        console.log(
            'the rescued word is clamped as the last word of its window',
        );
    });

    it('gives the trailing word a window when the loop recorded none', () => {
        const clamped = clampWindowWords(
            [word('a', 0, 9)],
            [],
            word('b', 9, 20),
            { maxDur: 2, mediumFactor: false },
        );

        assert.deepEqual(spans(clamped), [
            { text: 'a', start: 0, end: 9 },
            { text: 'b', start: 18, end: 20 },
        ]);

        console.log('a trailing word with no recorded range is still clamped');
    });

    it('leaves every word alone when clamping is off', () => {
        const clamped = clampWindowWords(
            [word('a', 0, 1), word('b', 1, 9)],
            [[0, 2]],
            word('c', 9, 30),
            false,
        );

        assert.deepEqual(spans(clamped), [
            { text: 'a', start: 0, end: 1 },
            { text: 'b', start: 1, end: 9 },
            { text: 'c', start: 9, end: 30 },
        ]);

        console.log('clamping off keeps the rescued word untouched too');
    });

    it('clamps each window on its own when there is no trailing word', () => {
        const clamped = clampWindowWords(
            [
                word('a', 0, 1),
                word('b', 1, 5),
                word('c', 4, 5),
                word('d', 5, 20),
            ],
            [
                [0, 2],
                [2, 4],
            ],
            null,
            { maxDur: 2, mediumFactor: false },
        );

        assert.deepEqual(spans(clamped), [
            { text: 'a', start: 0, end: 1 },
            { text: 'b', start: 1, end: 3 },
            { text: 'c', start: 4, end: 5 },
            { text: 'd', start: 5, end: 7 },
        ]);

        console.log('windows stay independent when nothing trails the loop');
    });
});
