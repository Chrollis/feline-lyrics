import { checkPcmAudio } from '../audio/check.js';
import type { PcmAudio } from '../audio/types.js';
import { StemalignError } from '../errors.js';

export interface ChunkPlan {
    readonly frames: number;
    readonly overlap: number;
    readonly channels: number;
}

export type ChunkRunner = (
    chunk: PcmAudio,
    index: number,
    total: number,
) => Promise<readonly PcmAudio[]>;

export function chunkOffsets(
    frameCount: number,
    plan: ChunkPlan,
): readonly number[] {
    checkPlan(plan);
    const overlapFrames = Math.round(plan.frames * plan.overlap);
    const stride = plan.frames - overlapFrames;
    const offsets: number[] = [];
    for (let offset = 0; offset < frameCount; offset += stride) {
        offsets.push(offset);
    }
    if (offsets.length === 0) {
        offsets.push(0);
    }
    return offsets;
}

export async function separateChunks(
    audio: PcmAudio,
    plan: ChunkPlan,
    runChunk: ChunkRunner,
): Promise<readonly PcmAudio[]> {
    const info = checkPcmAudio(audio);
    checkPlan(plan);
    if (info.channelCount !== plan.channels) {
        throw new StemalignError(
            'unsupported-layout',
            `the chunk plan needs ${plan.channels} channels, got ${info.channelCount}`,
            {
                expected: `${plan.channels} channels`,
                actual: `${info.channelCount} channels`,
            },
        );
    }
    const overlapFrames = Math.round(plan.frames * plan.overlap);
    const offsets = chunkOffsets(info.frameCount, plan);
    const weight = new Float32Array(info.frameCount);
    for (const offset of offsets) {
        const valid = Math.min(plan.frames, info.frameCount - offset);
        const window = chunkWindow(plan.frames, overlapFrames, valid);
        for (let local = 0; local < valid; local += 1) {
            weight[offset + local] += window[local];
        }
    }
    let stems: Float32Array[][] = [];
    for (const [index, offset] of offsets.entries()) {
        const valid = Math.min(plan.frames, info.frameCount - offset);
        const window = chunkWindow(plan.frames, overlapFrames, valid);
        const chunk = buildChunk(audio, plan, offset, valid);
        const produced = await runChunk(chunk, index, offsets.length);
        checkProduced(produced, plan, info.sampleRate);
        if (stems.length === 0) {
            stems = produced.map(() =>
                audio.channels.map(() => new Float32Array(info.frameCount)),
            );
        }
        for (const [stemIndex, stem] of produced.entries()) {
            const target = stems[stemIndex];
            for (let local = 0; local < valid; local += 1) {
                const frame = offset + local;
                for (const [channelIndex, channel] of stem.channels.entries()) {
                    target[channelIndex][frame] +=
                        channel[local] * window[local];
                }
            }
        }
    }
    for (const channels of stems) {
        for (const channel of channels) {
            for (let frame = 0; frame < info.frameCount; frame += 1) {
                channel[frame] /= weight[frame];
            }
        }
    }
    return stems.map((channels) => ({
        sampleRate: info.sampleRate,
        channels,
    }));
}

function buildChunk(
    audio: PcmAudio,
    plan: ChunkPlan,
    offset: number,
    valid: number,
): PcmAudio {
    return {
        sampleRate: audio.sampleRate,
        channels: audio.channels.map((channel) => {
            const chunk = new Float32Array(plan.frames);
            chunk.set(channel.subarray(offset, offset + valid));
            return chunk;
        }),
    };
}

function chunkWeight(
    frames: number,
    overlapFrames: number,
    index: number,
): number {
    if (index < overlapFrames) {
        return (index + 0.5) / overlapFrames;
    }
    const tail = frames - 1 - index;
    if (tail < overlapFrames) {
        return (tail + 0.5) / overlapFrames;
    }
    return 1;
}

function chunkWindow(
    frames: number,
    overlapFrames: number,
    valid: number,
): Float32Array {
    const window = new Float32Array(valid);
    for (let index = 0; index < valid; index += 1) {
        window[index] = chunkWeight(frames, overlapFrames, index);
    }
    return window;
}

function checkPlan(plan: ChunkPlan): void {
    if (!Number.isInteger(plan.frames) || plan.frames < 1) {
        throw new StemalignError(
            'model-invalid',
            `the chunk plan needs a positive integer frame count, got ${plan.frames}`,
            {
                expected: 'a positive integer frame count',
                actual: String(plan.frames),
            },
        );
    }
    if (!(plan.overlap >= 0 && plan.overlap <= 0.5)) {
        throw new StemalignError(
            'model-invalid',
            `the chunk plan needs an overlap in [0, 0.5], got ${plan.overlap}`,
            {
                expected: 'an overlap in [0, 0.5]',
                actual: String(plan.overlap),
            },
        );
    }
    if (!Number.isInteger(plan.channels) || plan.channels < 1) {
        throw new StemalignError(
            'model-invalid',
            `the chunk plan needs a positive integer channel count, got ${plan.channels}`,
            {
                expected: 'a positive integer channel count',
                actual: String(plan.channels),
            },
        );
    }
}

function checkProduced(
    produced: readonly PcmAudio[],
    plan: ChunkPlan,
    sampleRate: number,
): void {
    if (produced.length === 0) {
        throw new StemalignError(
            'model-invalid',
            'the model produced no stems for one chunk',
            {
                expected: 'at least one stem',
                actual: '0 stems',
            },
        );
    }
    for (const stem of produced) {
        if (stem.sampleRate !== sampleRate) {
            throw new StemalignError(
                'model-invalid',
                `a produced stem has sample rate ${stem.sampleRate}, the input has ${sampleRate}`,
                {
                    expected: String(sampleRate),
                    actual: String(stem.sampleRate),
                },
            );
        }
        if (stem.channels.length !== plan.channels) {
            throw new StemalignError(
                'model-invalid',
                `a produced stem has ${stem.channels.length} channels, the chunk plan needs ${plan.channels}`,
                {
                    expected: `${plan.channels} channels`,
                    actual: `${stem.channels.length} channels`,
                },
            );
        }
        for (const channel of stem.channels) {
            if (channel.length !== plan.frames) {
                throw new StemalignError(
                    'model-invalid',
                    `a produced stem channel has ${channel.length} frames, the chunk plan needs ${plan.frames}`,
                    {
                        expected: `${plan.frames} frames`,
                        actual: `${channel.length} frames`,
                    },
                );
            }
        }
    }
}
