import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { inspectDemucs, openModel, separate } from '../../../out/main/index.js';

const DEFAULT_PATHS = [
    '../../models/StemSplitio/htdemucs-onnx/htdemucs.onnx',
    '../../models/StemSplitio/htdemucs-onnx/htdemucs_fp16weights.onnx',
    '../../models/StemSplitio/htdemucs-6s-onnx/htdemucs_6s.onnx',
    '../../models/StemSplitio/htdemucs-6s-onnx/htdemucs_6s_fp16weights.onnx',
];

const SAMPLE_RATE = 44100;
const SECONDS = 3;

// Reconstruction is a property of each model, not of the chunking path: the four
// source masks sum back to the mix, the six source masks do not (0.235 even for a
// single window measured straight from the session, no chunking involved).
const RECONSTRUCTION_LIMITS = new Map([
    [4, 0.05],
    [6, 0.35],
]);

function tone(frequency) {
    const length = SAMPLE_RATE * SECONDS;
    return Float32Array.from(
        { length },
        (_, index) =>
            0.4 * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE),
    );
}

function channelError(stems, source, channelIndex) {
    const sum = new Float32Array(source.length);
    for (const stem of stems) {
        const channel = stem.audio.channels[channelIndex];
        assert.equal(
            channel.length,
            source.length,
            `stem ${stem.track} has the wrong length`,
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

function parity(first, second) {
    let worst = 0;
    for (const [index, stem] of first.stems.entries()) {
        const other = second.stems[index];
        assert.equal(other.track, stem.track);
        for (const [channelIndex, channel] of stem.audio.channels.entries()) {
            const otherChannel = other.audio.channels[channelIndex];
            for (let frame = 0; frame < channel.length; frame += 1) {
                worst = Math.max(
                    worst,
                    Math.abs(channel[frame] - otherChannel[frame]),
                );
            }
        }
    }
    return worst;
}

function find(results, suffix) {
    for (const [name, result] of results) {
        if (name.endsWith(suffix)) {
            return result;
        }
    }
    return undefined;
}

const input = {
    sampleRate: SAMPLE_RATE,
    channels: [tone(220), tone(330)],
};

const results = new Map();
const given = process.argv.slice(2);
for (const path of given.length > 0 ? given : DEFAULT_PATHS) {
    const bytes = await readFile(path);
    const openedAt = Date.now();
    const handle = await openModel({
        id: basename(path),
        sessions: { model: { bytes } },
        executionProviders: ['cpu'],
    });
    const openMs = Date.now() - openedAt;
    try {
        const layout = inspectDemucs(handle);
        const startedAt = Date.now();
        // One fixed pass keeps the fp16 parity honest: the default runs a single
        // randomized shift, so two opens would compare different delays.
        const stems = await separate(input, handle, { shifts: 0 });
        const runMs = Date.now() - startedAt;
        assert.equal(stems.length, layout.stems);
        assert.deepEqual(
            stems.map((stem) => stem.track),
            layout.tracks,
        );
        const worst = Math.max(
            channelError(stems, input.channels[0], 0),
            channelError(stems, input.channels[1], 1),
        );
        console.log(
            `${basename(path)}: ${layout.stems} stems [${layout.tracks.join(' ')}] open ${openMs} ms run ${runMs} ms reconstruction ${worst.toFixed(6)}`,
        );
        const limit = RECONSTRUCTION_LIMITS.get(layout.stems);
        assert.ok(
            limit !== undefined,
            `no reconstruction limit is recorded for ${layout.stems} stems`,
        );
        assert.ok(
            worst < limit,
            `the stems must add up to the mix, worst ${worst} above ${limit}`,
        );
        results.set(basename(path), { stems });
    } finally {
        await handle.release();
    }
}

for (const [plain, half] of [
    ['htdemucs.onnx', 'htdemucs_fp16weights.onnx'],
    ['htdemucs_6s.onnx', 'htdemucs_6s_fp16weights.onnx'],
]) {
    const first = find(results, plain);
    const second = find(results, half);
    if (first === undefined || second === undefined) {
        continue;
    }
    const worst = parity(first, second);
    console.log(`fp16 weights parity ${plain} vs ${half}: ${worst.toFixed(8)}`);
    assert.ok(
        worst < 0.01,
        `the fp16 weights export must match, worst ${worst}`,
    );
}

console.log('every export kept its declared shape and track order');
