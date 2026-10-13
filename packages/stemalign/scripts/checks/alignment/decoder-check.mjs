import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { openModel } from '../../../out/main/index.js';
import { inspectWhisper } from '../../../out/main/alignment/whisper.js';
import { inspectWhisperSettings } from '../../../out/main/alignment/settings.js';
import { inspectWhisperTokenizer } from '../../../out/main/alignment/tokenizer.js';
import {
    emittedTokenProbabilities,
    runDecoder,
} from '../../../out/main/alignment/decoder.js';

const directory = new URL(
    '../../../../../models/Xenova/whisper-base/',
    import.meta.url,
);
const text = (name) => readFileSync(new URL(name, directory), 'utf8');
const bytes = (name) => readFileSync(new URL(name, directory));

const started = Date.now();
const handle = await openModel({
    id: 'whisper-base',
    sessions: {
        encoder: { bytes: bytes('onnx/encoder_model.onnx') },
        decoder: { bytes: bytes('onnx/decoder_model_merged.onnx') },
    },
    settings: {
        config: text('config.json'),
        generation: text('generation_config.json'),
        preprocessor: text('preprocessor_config.json'),
        tokenizer: text('tokenizer.json'),
    },
    executionProviders: ['cpu'],
});

try {
    const layout = inspectWhisper(handle);
    const settings = inspectWhisperSettings(handle, layout);
    const tokenizer = inspectWhisperTokenizer(handle, settings);
    console.log('opened in', Date.now() - started, 'ms');

    const languageId = settings.languageIds['<|en|>'];
    const taskId = settings.taskIds['transcribe'];
    assert.equal(
        typeof languageId,
        'number',
        'the model must know the <|en|> token',
    );
    assert.equal(
        typeof taskId,
        'number',
        'the model must know the transcribe token',
    );
    const textIds = tokenizer.encode('Hello, world!');
    const tokenIds = [
        settings.decoderStartTokenId,
        languageId,
        taskId,
        settings.noTimestampsTokenId,
        ...textIds,
        settings.eosTokenId,
    ];

    const frames = settings.maxSourcePositions;
    const modelSize = layout.heads * layout.headDim;
    const hiddenStates = new Float32Array(frames * modelSize);

    const time = Date.now();
    const pass = await runDecoder(handle, layout, settings, {
        hiddenStates,
        tokenIds,
    });
    console.log('decoded', pass.tokens, 'tokens in', Date.now() - time, 'ms');

    assert.equal(pass.tokens, tokenIds.length);
    assert.equal(pass.frames, frames);
    assert.equal(pass.probabilities.length, tokenIds.length - 1);
    assert.equal(pass.attentions.length, settings.alignmentHeads.length);

    let worstRowSum = 0;
    for (const [index, attention] of pass.attentions.entries()) {
        const expected = settings.alignmentHeads[index];
        assert.equal(attention.layer, expected.layer);
        assert.equal(attention.head, expected.head);
        assert.equal(attention.values.length, pass.tokens * frames);
        for (let token = 0; token < pass.tokens; token += 1) {
            let sum = 0;
            for (let frame = 0; frame < frames; frame += 1) {
                sum += attention.values[token * frames + frame];
            }
            worstRowSum = Math.max(worstRowSum, Math.abs(sum - 1));
        }
    }
    console.log('worst deviation from a row sum of one:', worstRowSum);
    assert.ok(
        worstRowSum < 1e-4,
        `attention rows must sum to one, worst ${worstRowSum}`,
    );

    // runDecoder releases the logits tensor, so the extraction is pinned
    // against a naive softmax of synthetic logits instead of the real ones.
    const vocabulary = 6;
    const syntheticIds = [1, 4, 2, 5];
    const synthetic = new Float32Array(syntheticIds.length * vocabulary);
    for (let row = 0; row < syntheticIds.length; row += 1) {
        for (let id = 0; id < vocabulary; id += 1) {
            synthetic[row * vocabulary + id] = (row + 1) * (id + 1);
        }
    }
    const syntheticEot = 4;
    const extracted = emittedTokenProbabilities(
        synthetic,
        vocabulary,
        syntheticEot,
        syntheticIds,
    );
    assert.equal(extracted.length, syntheticIds.length - 1);
    for (let row = 0; row < extracted.length; row += 1) {
        const emitted = syntheticIds[row + 1];
        const values = [
            ...synthetic.slice(
                row * vocabulary,
                row * vocabulary + syntheticEot,
            ),
        ];
        let expected = 0;
        if (emitted >= 0 && emitted < syntheticEot) {
            const maximum = Math.max(...values);
            let total = 0;
            for (const value of values) {
                total += Math.exp(value - maximum);
            }
            expected = Math.exp(values[emitted] - maximum) / total;
        }
        assert.ok(
            Math.abs(extracted[row] - expected) < 1e-12,
            `row ${row}: got ${extracted[row]}, expected ${expected}`,
        );
    }
    assert.equal(extracted[0], 0, 'a token at or above eot must score zero');
    assert.equal(
        extracted[2],
        0,
        'the softmax must not cover ids at or above eot',
    );

    let lowest = Infinity;
    let highest = -Infinity;
    for (const value of pass.probabilities) {
        assert.ok(
            Number.isFinite(value) && value >= 0 && value <= 1,
            `a probability must stay inside [0, 1], got ${value}`,
        );
        lowest = Math.min(lowest, value);
        highest = Math.max(highest, value);
    }
    console.log('emitted probabilities span', lowest, 'to', highest);
    assert.equal(
        emittedTokenProbabilities(
            new Float32Array(vocabulary),
            vocabulary,
            1,
            [1],
        ).length,
        0,
        'a sequence of one token has no emitted token',
    );
    assert.throws(
        () =>
            emittedTokenProbabilities(new Float32Array(2), vocabulary, 1, [1]),
        (error) => error.code === 'invalid-option',
        'logits of the wrong size must be rejected',
    );
    assert.throws(
        () =>
            emittedTokenProbabilities(
                new Float32Array(vocabulary),
                vocabulary,
                vocabulary + 1,
                [1, 2],
            ),
        (error) => error.code === 'invalid-option',
        'an end of text token outside the vocabulary must be rejected',
    );

    const again = await runDecoder(handle, layout, settings, {
        hiddenStates,
        tokenIds,
    });
    assert.deepEqual(again.probabilities, pass.probabilities);
    for (const [index, attention] of pass.attentions.entries()) {
        assert.deepEqual(again.attentions[index].values, attention.values);
    }

    await assert.rejects(
        runDecoder(handle, layout, settings, {
            hiddenStates: new Float32Array(0),
            tokenIds,
        }),
        (error) => error.code === 'invalid-option',
    );
    await assert.rejects(
        runDecoder(handle, layout, settings, { hiddenStates, tokenIds: [] }),
        (error) => error.code === 'invalid-option',
    );
    await assert.rejects(
        runDecoder(handle, layout, settings, {
            hiddenStates,
            tokenIds: new Array(settings.maxTargetPositions + 1).fill(
                settings.decoderStartTokenId,
            ),
        }),
        (error) => error.code === 'invalid-option',
    );

    console.log('every decoder invariant holds');
} finally {
    await handle.release();
}
