import assert from 'node:assert/strict';
import { separateChunks } from '../../../out/main/index.js';

const plan = { frames: 16, overlap: 0.25, channels: 2 };
const length = 100;

function makeAudio(size) {
    const left = Float32Array.from({ length: size }, (_, i) =>
        Math.cos(i * 0.1),
    );
    const right = Float32Array.from({ length: size }, (_, i) =>
        Math.sin(i * 0.07),
    );
    return { sampleRate: 44100, channels: [left, right] };
}

function maxError(actual, expected) {
    let max = 0;
    for (let index = 0; index < expected.length; index += 1) {
        max = Math.max(max, Math.abs(actual[index] - expected[index]));
    }
    return max;
}

const audio = makeAudio(length);

const echo = async (chunk) => [chunk];
const identity = await separateChunks(audio, plan, echo);
assert.equal(identity.length, 1);
assert.equal(identity[0].sampleRate, 44100);
assert.equal(identity[0].channels[0].length, length);
for (const [index, channel] of identity[0].channels.entries()) {
    const error = maxError(channel, audio.channels[index]);
    assert.ok(
        error < 1e-6,
        `identity run must rebuild the input, error ${error}`,
    );
}
console.log('identity run rebuilds the input within 1e-6');

const scale = async (chunk) =>
    [1, 2, 3, 4].map((factor) => ({
        sampleRate: chunk.sampleRate,
        channels: chunk.channels.map((channel) =>
            Float32Array.from(channel, (value) => value * factor),
        ),
    }));
const four = await separateChunks(audio, plan, scale);
assert.equal(four.length, 4);
for (const [index, stem] of four.entries()) {
    const factor = index + 1;
    for (const [channelIndex, channel] of stem.channels.entries()) {
        const expected = Float32Array.from(
            audio.channels[channelIndex],
            (value) => value * factor,
        );
        const error = maxError(channel, expected);
        assert.ok(error < 1e-4, `stem ${index} must be scaled, error ${error}`);
    }
}
console.log('four stems come back routed and scaled');

await assert.rejects(
    separateChunks(audio, { ...plan, channels: 1 }, echo),
    (error) => error.code === 'unsupported-layout',
);
await assert.rejects(
    separateChunks(audio, { ...plan, overlap: 0.75 }, echo),
    (error) => error.code === 'model-invalid',
);
await assert.rejects(
    separateChunks(audio, { ...plan, frames: 0 }, echo),
    (error) => error.code === 'model-invalid',
);
await assert.rejects(
    separateChunks(audio, plan, async () => []),
    (error) => error.code === 'model-invalid',
);
await assert.rejects(
    separateChunks(audio, plan, async (chunk) => [
        { sampleRate: chunk.sampleRate, channels: [new Float32Array(4)] },
    ]),
    (error) => error.code === 'model-invalid',
);
console.log('plan and stem-shape violations are rejected');
console.log('chunking checks passed');

const paddingSource = Float32Array.from(
    { length: 100 },
    (_, index) => index + 1,
);
const paddingAudio = {
    sampleRate: 44100,
    channels: [paddingSource, paddingSource.slice()],
};
const paddingChunks = [];
await separateChunks(
    paddingAudio,
    { frames: 8, overlap: 0.25, channels: 2 },
    async (chunk) => {
        paddingChunks.push(Array.from(chunk.channels[0]));
        return [
            {
                sampleRate: chunk.sampleRate,
                channels: chunk.channels.map((channel) => channel.slice()),
            },
        ];
    },
);
assert.equal(paddingChunks.length, 17);
assert.deepEqual(paddingChunks[0], [1, 2, 3, 4, 5, 6, 7, 8]);
assert.deepEqual(paddingChunks[16], [97, 98, 99, 100, 0, 0, 0, 0]);
console.log('the last chunk is zero padded');
