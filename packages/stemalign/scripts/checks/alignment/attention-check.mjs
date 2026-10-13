import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { openModel } from '../../../out/main/index.js';
import { inspectWhisper } from '../../../out/main/alignment/whisper.js';
import { inspectWhisperSettings } from '../../../out/main/alignment/settings.js';
import { inspectWhisperTokenizer } from '../../../out/main/alignment/tokenizer.js';
import { melSpectrogram } from '../../../out/main/alignment/mel.js';
import { runEncoder } from '../../../out/main/alignment/encoder.js';
import { runDecoder } from '../../../out/main/alignment/decoder.js';
import { computeAttentionWeights } from '../../../out/main/alignment/attention.js';

const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 3;

function buildChunk() {
    const frames = Math.round(SAMPLE_RATE * CHUNK_SECONDS);
    const samples = new Float32Array(frames);
    for (let index = 0; index < frames; index += 1) {
        const second = index / SAMPLE_RATE;
        const frequency = second < CHUNK_SECONDS / 2 ? 440 : 660;
        const envelope = second % 1 < 0.25 ? 0 : 1;
        samples[index] =
            (0.4 * envelope * Math.sin(2 * Math.PI * frequency * index)) /
            SAMPLE_RATE;
    }
    return samples;
}

function oracleWeights(pass, sotLen, nTokens, nFrames, width) {
    const half = (width - 1) / 2;
    const heads = [];
    for (const attention of pass.attentions) {
        const plane = [];
        for (let token = 0; token < nTokens; token += 1) {
            const row = [];
            for (let frame = 0; frame < nFrames; frame += 1) {
                row.push(
                    attention.values[
                        (sotLen + token) * attention.frames + frame
                    ],
                );
            }
            plane.push(row);
        }
        heads.push(plane);
    }
    for (const plane of heads) {
        for (const row of plane) {
            const maximum = Math.max(...row);
            const exponents = row.map((value) => Math.exp(value - maximum));
            const total = exponents.reduce((sum, value) => sum + value, 0);
            for (let frame = 0; frame < nFrames; frame += 1) {
                row[frame] = exponents[frame] / total;
            }
        }
    }
    for (const plane of heads) {
        for (let frame = 0; frame < nFrames; frame += 1) {
            let sum = 0;
            for (const row of plane) {
                sum += row[frame];
            }
            const mean = sum / nTokens;
            let squares = 0;
            for (const row of plane) {
                squares += (row[frame] - mean) ** 2;
            }
            const deviation = Math.sqrt(squares / nTokens);
            for (const row of plane) {
                row[frame] =
                    deviation === 0 ? 0 : (row[frame] - mean) / deviation;
            }
        }
    }
    const values = [];
    for (const plane of heads) {
        for (const row of plane) {
            const padded = [];
            for (let index = 0; index < nFrames + 2 * half; index += 1) {
                const offset = index - half;
                if (offset < 0) {
                    padded.push(row[-offset]);
                } else if (offset >= nFrames) {
                    padded.push(row[2 * (nFrames - 1) - offset]);
                } else {
                    padded.push(row[offset]);
                }
            }
            for (let index = 0; index < nFrames; index += 1) {
                const window = padded
                    .slice(index, index + width)
                    .sort((left, right) => left - right);
                values.push(window[half]);
            }
        }
    }
    return values;
}

const directory = new URL(
    '../../../../../models/Xenova/whisper-base/',
    import.meta.url,
);
const handle = await openModel({
    id: 'whisper-base',
    sessions: {
        encoder: {
            bytes: readFileSync(new URL('onnx/encoder_model.onnx', directory)),
        },
        decoder: {
            bytes: readFileSync(
                new URL('onnx/decoder_model_merged.onnx', directory),
            ),
        },
    },
    settings: {
        config: readFileSync(new URL('config.json', directory), 'utf8'),
        generation: readFileSync(
            new URL('generation_config.json', directory),
            'utf8',
        ),
        preprocessor: readFileSync(
            new URL('preprocessor_config.json', directory),
            'utf8',
        ),
        tokenizer: readFileSync(new URL('tokenizer.json', directory), 'utf8'),
    },
    executionProviders: ['cpu'],
});

try {
    const layout = inspectWhisper(handle);
    const settings = inspectWhisperSettings(handle, layout);
    const tokenizer = inspectWhisperTokenizer(handle, settings);
    const languageId = settings.languageIds['<|en|>'];
    assert.equal(
        typeof languageId,
        'number',
        'the model must know the <|en|> token',
    );
    const sotSequence = [
        settings.decoderStartTokenId,
        languageId,
        settings.taskIds['transcribe'],
    ];
    const textIds = tokenizer.encode(
        'Hello world, this is a test of the alignment pipeline.',
    );
    const tokenIds = [
        ...sotSequence,
        settings.noTimestampsTokenId,
        ...textIds,
        settings.eosTokenId,
    ];

    const chunk = { sampleRate: SAMPLE_RATE, channels: [buildChunk()] };
    const numSamples = chunk.channels[0].length;
    const mel = melSpectrogram(chunk, settings);
    const hiddenStates = await runEncoder(handle, layout, settings, mel);
    const pass = await runDecoder(handle, layout, settings, {
        hiddenStates,
        tokenIds,
    });
    const result = computeAttentionWeights(pass, settings, {
        sotLen: sotSequence.length,
        numSamples,
    });

    assert.equal(result.nHeads, settings.alignmentHeads.length);
    assert.equal(result.nTokens, textIds.length + 1);
    assert.equal(result.maxQkLen, numSamples / 320);
    assert.equal(result.nFrames, numSamples / 320);
    assert.equal(
        result.weights.length,
        result.nHeads * result.nTokens * result.nFrames,
    );
    assert.equal(pass.attentions.length, settings.alignmentHeads.length);
    for (let index = 0; index < pass.attentions.length; index += 1) {
        const attention = pass.attentions[index];
        const head = settings.alignmentHeads[index];
        assert.equal(attention.layer, head.layer);
        assert.equal(attention.head, head.head);
    }
    for (const value of result.weights) {
        assert.ok(Number.isFinite(value), 'every weight must be finite');
    }

    const expected = oracleWeights(
        pass,
        sotSequence.length,
        result.nTokens,
        result.nFrames,
        settings.medianFilterWidth,
    );
    let worst = 0;
    for (let index = 0; index < expected.length; index += 1) {
        worst = Math.max(
            worst,
            Math.abs(expected[index] - result.weights[index]),
        );
    }
    console.log(
        `worst difference against the naive float64 reference: ${worst}`,
    );
    assert.ok(worst < 0.01, `attention weights deviate by ${worst}`);

    const again = computeAttentionWeights(pass, settings, {
        sotLen: sotSequence.length,
        numSamples,
    });
    assert.deepEqual(again.weights, result.weights);

    assert.throws(
        () =>
            computeAttentionWeights(pass, settings, {
                sotLen: tokenIds.length,
                numSamples,
            }),
        (error) => error.code === 'invalid-option',
    );
    const broken = {
        ...pass,
        attentions: pass.attentions.map((attention, index) =>
            index === 0
                ? { ...attention, frames: attention.frames + 1 }
                : attention,
        ),
    };
    assert.throws(
        () =>
            computeAttentionWeights(broken, settings, {
                sotLen: sotSequence.length,
                numSamples,
            }),
        (error) => error.code === 'model-invalid',
    );

    console.log(
        `attention heads ${result.nHeads}, text tokens ${result.nTokens}, frames ${result.nFrames} of ${result.maxQkLen}`,
    );
    console.log('every attention invariant holds');
} finally {
    await handle.release();
}
