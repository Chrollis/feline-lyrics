import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { openModel } from '../../../out/main/index.js';
import { inspectWhisper } from '../../../out/main/alignment/whisper.js';
import { inspectWhisperSettings } from '../../../out/main/alignment/settings.js';
import { melSpectrogram } from '../../../out/main/alignment/mel.js';
import { runEncoder } from '../../../out/main/alignment/encoder.js';

const directory = new URL(
    '../../../../../models/Xenova/whisper-base/',
    import.meta.url,
);
const text = (name) => readFileSync(new URL(name, directory), 'utf8');
const bytes = (name) => readFileSync(new URL(name, directory));

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

    const samples = settings.sampleRate;
    const audio = {
        sampleRate: settings.sampleRate,
        channels: [
            Float32Array.from({ length: samples }, (_, index) => {
                return (
                    Math.sin(
                        (2 * Math.PI * 440 * index) / settings.sampleRate,
                    ) * 0.5
                );
            }),
        ],
    };
    const mel = melSpectrogram(audio, settings);
    assert.equal(mel.melBins, settings.melBins);
    assert.equal(mel.frames, settings.nbMaxFrames);

    const frames = settings.maxSourcePositions;
    const modelSize = layout.heads * layout.headDim;
    const time = Date.now();
    const hiddenStates = await runEncoder(handle, layout, settings, mel);
    console.log('encoded in', Date.now() - time, 'ms');
    assert.equal(hiddenStates.length, frames * modelSize);
    for (const value of hiddenStates.subarray(0, 8)) {
        assert.ok(Number.isFinite(value), 'hidden states must be finite');
    }

    const again = await runEncoder(handle, layout, settings, mel);
    assert.deepEqual(again, hiddenStates);
    assert.notEqual(again, hiddenStates);

    await assert.rejects(
        runEncoder(handle, layout, settings, {
            melBins: settings.melBins + 1,
            frames: mel.frames,
            values: mel.values,
        }),
        (error) => error.code === 'invalid-option',
    );
    await assert.rejects(
        runEncoder(handle, layout, settings, {
            melBins: mel.melBins,
            frames: mel.frames - 1,
            values: mel.values,
        }),
        (error) => error.code === 'invalid-option',
    );

    console.log('every encoder invariant holds');
} finally {
    await handle.release();
}
