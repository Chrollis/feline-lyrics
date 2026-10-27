import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectWhisperSettings } from '../../src/main/alignment/settings.js';
import { inspectWhisperTokenizer } from '../../src/main/alignment/tokenizer.js';
import { wordTimings } from '../../src/main/alignment/timestamps.js';
import { splitWords } from '../../src/main/alignment/words.js';
import { describe, it } from 'node:test';

describe('word timings', () => {
    it('turns jumps into timings', async () => {
        const directory = new URL('../fixtures/whisper-base/', import.meta.url);
        const settings = {
            tokenizer: readFileSync(
                new URL('tokenizer.json', directory),
                'utf8',
            ),
            config: readFileSync(new URL('config.json', directory), 'utf8'),
            generation: readFileSync(
                new URL('generation_config.json', directory),
                'utf8',
            ),
            preprocessor: readFileSync(
                new URL('preprocessor_config.json', directory),
                'utf8',
            ),
        };

        const config = JSON.parse(settings.config);
        const handle = { id: 'whisper-base', settings };
        const layout = {
            layers: config.decoder_layers,
            heads: config.decoder_attention_heads,
            headDim: config.d_model / config.decoder_attention_heads,
            vocabSize: config.vocab_size,
            melBins: config.num_mel_bins,
        };

        const inspected = inspectWhisperSettings(handle, layout);
        const tokenizer = inspectWhisperTokenizer(handle, inspected);

        // whisper-base reports one 0.02 s token every 320 samples: 160 samples per
        // mel frame and two mel frames per encoder frame.
        const tokensPerSecond =
            inspected.sampleRate / (inspected.hopLength * 2);
        assert.equal(inspected.sampleRate, 16000);
        assert.equal(inspected.hopLength, 160);
        assert.equal(tokensPerSecond, 50);

        const split = splitWords(tokenizer, tokenizer.encode('Hello, world!'));
        assert.deepEqual(split, {
            words: ['Hello,', ' world!'],
            tokens: [
                [15947, 11],
                [1002, 0],
            ],
        });

        // Row 0 is the <|notimestamps|> row, so the first word owns rows 0 through 2
        // and the second one rows 2 through 4.
        const jumps = { jumpIndices: Int32Array.from([0, 25, 50, 75, 100]) };
        assert.deepEqual(wordTimings(split, jumps, inspected), [
            {
                word: 'Hello,',
                tokens: [15947, 11],
                start: 0,
                end: 1,
                probability: 0,
            },
            {
                word: ' world!',
                tokens: [1002, 0],
                start: 1,
                end: 2,
                probability: 0,
            },
        ]);

        // 1.5 tokens per second makes the millisecond rounding visible.
        const slow = { sampleRate: 3, hopLength: 1 };
        const tinySplit = { words: ['a', 'b'], tokens: [[1], [2]] };
        const tinyJumps = { jumpIndices: Int32Array.from([0, 1, 2]) };
        assert.deepEqual(wordTimings(tinySplit, tinyJumps, slow), [
            { word: 'a', tokens: [1], start: 0, end: 0.667, probability: 0 },
            {
                word: 'b',
                tokens: [2],
                start: 0.667,
                end: 1.333,
                probability: 0,
            },
        ]);

        // Probabilities average over the token rows of a word and clamp to the length
        // of the list, exactly like the reference does.
        assert.deepEqual(
            wordTimings(split, jumps, inspected, {
                probabilities: [0.75, 0.25, 0.5, 1],
            }).map((timing) => timing.probability),
            [0.5, 0.75],
        );
        assert.deepEqual(
            wordTimings(split, jumps, inspected, {
                probabilities: [0.75, 0.25, 0.5],
            }).map((timing) => timing.probability),
            [0.5, 0.5],
        );

        // A word that starts past the end of the probability list is a caller error,
        // and so are a mismatched split, a jump list that cannot hold the words and a
        // non-positive token rate.
        assert.throws(
            () =>
                wordTimings(split, jumps, inspected, {
                    probabilities: [0.5, 0.5],
                }),
            (error) => error.code === 'invalid-option',
        );
        assert.throws(
            () => wordTimings({ words: ['a'], tokens: [] }, jumps, inspected),
            (error) => error.code === 'invalid-option',
        );
        assert.throws(
            () =>
                wordTimings(
                    split,
                    { jumpIndices: Int32Array.from([0, 1, 2, 3]) },
                    inspected,
                ),
            (error) => error.code === 'invalid-option',
        );
        assert.throws(
            () => wordTimings(split, jumps, { sampleRate: 0, hopLength: 160 }),
            (error) => error.code === 'invalid-option',
        );

        // One token per word and one jump row per second keeps the arithmetic exact.
        const manyJumps = {
            jumpIndices: Int32Array.from([0, 50, 100, 150, 200]),
        };
        const manySplit = {
            words: ['a', 'b', 'c', 'd'],
            tokens: [[1], [2], [3], [4]],
        };
        const many = wordTimings(manySplit, manyJumps, inspected);
        assert.deepEqual(
            many.map((timing) => [timing.start, timing.end]),
            [
                [0, 1],
                [1, 2],
                [2, 3],
                [3, 4],
            ],
        );
        assert.deepEqual(
            many.map((timing) => timing.word),
            ['a', 'b', 'c', 'd'],
        );
        assert.deepEqual(
            many.map((timing) => timing.tokens),
            manySplit.tokens,
        );
        for (const timing of many) {
            assert.ok(timing.start <= timing.end);
        }
        for (let index = 1; index < many.length; index += 1) {
            assert.ok(many[index - 1].end <= many[index].start);
        }

        console.log(`the token rate is ${tokensPerSecond} per second`);
        console.log(
            `word timings follow the jump rows for ${many.length} words`,
        );
        console.log(
            'probabilities average over each word and clamp to the list',
        );
        console.log('every invalid input is rejected');
        console.log('every timestamp invariant holds');
    });
});
