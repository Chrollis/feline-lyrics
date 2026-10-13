import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openModel, separate } from '../../../out/main/index.js';

const modelPath = process.argv[2];
if (modelPath === undefined) {
    throw new Error('usage: node scripts/separate-check.mjs <htdemucs.onnx>');
}

function tone(sampleRate, seconds, frequency, amplitude) {
    const length = Math.round(sampleRate * seconds);
    return Float32Array.from(
        { length },
        (_, index) =>
            amplitude *
            Math.sin((2 * Math.PI * frequency * index) / sampleRate),
    );
}

function channelError(stems, source, channelIndex) {
    const sum = new Float32Array(source.length);
    for (const stem of stems) {
        const channel = stem.audio.channels[channelIndex];
        assert.equal(
            channel.length,
            source.length,
            `stem ${stem.track} channel ${channelIndex} has the wrong length`,
        );
        for (let frame = 0; frame < source.length; frame += 1) {
            sum[frame] += channel[frame];
        }
    }
    let worst = 0;
    for (let frame = 0; frame < source.length; frame += 1) {
        worst = Math.max(worst, Math.abs(sum[frame] - source[frame]));
    }
    return worst;
}

const bytes = await readFile(modelPath);
const handle = await openModel({
    id: 'htdemucs',
    sessions: { model: { bytes } },
    executionProviders: ['cpu'],
});

try {
    const sampleRate = 44100;
    const input = {
        sampleRate,
        channels: [
            tone(sampleRate, 9, 220, 0.5),
            tone(sampleRate, 9, 330, 0.5),
        ],
    };
    const events = [];
    const stems = await separate(input, handle, {
        shifts: 0,
        onProgress: (event) => events.push(event),
    });
    assert.deepEqual(events, [
        { stage: 'chunk', completed: 0, total: 2 },
        { stage: 'chunk', completed: 1, total: 2 },
        { stage: 'chunk', completed: 2, total: 2 },
    ]);
    assert.equal(stems.length, 4);
    assert.deepEqual(
        stems.map((stem) => stem.track),
        ['drums', 'bass', 'other', 'vocals'],
    );
    for (const stem of stems) {
        assert.equal(stem.audio.sampleRate, sampleRate);
        assert.equal(stem.audio.channels.length, 2);
        assert.equal(stem.audio.channels[0].length, input.channels[0].length);
    }
    const worst = Math.max(
        channelError(stems, input.channels[0], 0),
        channelError(stems, input.channels[1], 1),
    );
    console.log(`worst reconstruction error: ${worst.toFixed(6)}`);
    assert.ok(worst < 0.1, `the stems must add up to the mix, worst ${worst}`);

    const mono = {
        sampleRate: 16000,
        channels: [tone(16000, 1, 440, 0.5)],
    };
    const monoEvents = [];
    const monoStems = await separate(mono, handle, {
        shifts: 0,
        onProgress: (event) => monoEvents.push(event),
    });
    assert.deepEqual(monoEvents, [
        { stage: 'chunk', completed: 0, total: 1 },
        { stage: 'chunk', completed: 1, total: 1 },
    ]);
    assert.equal(monoStems.length, 4);
    for (const stem of monoStems) {
        assert.equal(stem.audio.sampleRate, 16000);
        assert.equal(stem.audio.channels.length, 2);
        assert.equal(stem.audio.channels[0].length, mono.channels[0].length);
    }

    const controller = new AbortController();
    controller.abort();
    const abortedEvents = [];
    await assert.rejects(
        separate(mono, handle, {
            shifts: 0,
            signal: controller.signal,
            onProgress: (event) => abortedEvents.push(event),
        }),
        (error) => error.code === 'cancelled',
    );
    assert.deepEqual(abortedEvents, []);

    const shiftedEvents = [];
    const shiftedStems = await separate(mono, handle, {
        shifts: 1,
        onProgress: (event) => shiftedEvents.push(event),
    });
    assert.deepEqual(shiftedEvents, [
        { stage: 'chunk', completed: 0, total: 1 },
        { stage: 'chunk', completed: 1, total: 1 },
    ]);
    assert.equal(shiftedStems.length, 4);
    for (const stem of shiftedStems) {
        assert.equal(stem.audio.channels.length, 2);
        assert.equal(stem.audio.channels[0].length, mono.channels[0].length);
    }
    console.log(
        'a shifted run covers the same frames and reports the same chunk total',
    );

    console.log(
        'a nine second stereo mix and a one second mono mix both produced four stems',
    );
    console.log(
        'progress events match the chunk count and an aborted run reports none',
    );
} finally {
    await handle.release();
}
