import { Tensor } from 'onnxruntime-node';
import { checkPcmAudio } from '../audio/check.js';
import { toChannelCount } from '../audio/channels.js';
import { resample } from '../audio/resample.js';
import type { PcmAudio } from '../audio/types.js';
import { StemalignError } from '../errors.js';
import {
    requireSession,
    type ModelHandle,
    type ModelSession,
} from '../model/session.js';
import type { DemucsLayout } from './demucs.js';
import { DEMUCS_OVERLAP, DEMUCS_SHIFTS, inspectDemucs } from './demucs.js';
import { chunkOffsets, separateChunks } from './chunking.js';
import type { ChunkPlan } from './chunking.js';
import { buildShiftDelays, delayAudio } from './sep-shifts.js';
import { halfToFloat32 } from '../model/half.js';
import { describeDims, requireTensor } from '../model/tensor.js';
import type { ProgressReporter } from '../progress.js';

export interface Stem {
    readonly track: string;
    readonly audio: PcmAudio;
}

export interface SeparateOptions {
    readonly tracks?: readonly string[];
    readonly shifts?: number;
    readonly outputSampleRate?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: ProgressReporter;
}

export async function separate(
    audio: PcmAudio,
    handle: ModelHandle,
    options?: SeparateOptions,
): Promise<readonly Stem[]> {
    const info = checkPcmAudio(audio);
    const layout = inspectDemucs(handle, options?.tracks);
    const channels = layoutChannels(layout);
    const session = requireSession(handle, layout.session);
    const prepared = toChannelCount(
        resample(audio, layout.sampleRate),
        channels,
    );
    const frameCount = checkPcmAudio(prepared).frameCount;
    const plan: ChunkPlan = {
        frames: layout.frames,
        overlap: DEMUCS_OVERLAP,
        channels,
    };
    const delays = buildShiftDelays(
        options?.shifts ?? DEMUCS_SHIFTS,
        prepared.sampleRate,
    );
    const total = delays.reduce(
        (sum, delay) => sum + chunkOffsets(frameCount + delay, plan).length,
        0,
    );
    const signal = options?.signal;
    const reporter = options?.onProgress;
    const sums: Float32Array[][] = [];
    let completed = 0;
    for (const delay of delays) {
        const produced = await separateChunks(
            delayAudio(prepared, delay),
            plan,
            async (chunk) => {
                if (signal !== undefined && signal.aborted) {
                    throw new StemalignError(
                        'cancelled',
                        `separation with session "${layout.session}" was cancelled before a chunk`,
                        { session: layout.session },
                    );
                }
                if (reporter !== undefined && completed === 0) {
                    reporter({ stage: 'chunk', completed: 0, total });
                }
                const stems = await runDemucs(session, layout, chunk);
                completed += 1;
                if (reporter !== undefined) {
                    reporter({ stage: 'chunk', completed, total });
                }
                return stems;
            },
        );
        if (sums.length === 0) {
            for (let index = 0; index < produced.length; index += 1) {
                sums.push(
                    prepared.channels.map(() => new Float32Array(frameCount)),
                );
            }
        }
        for (const [stemIndex, stem] of produced.entries()) {
            const target = sums[stemIndex];
            for (const [channelIndex, channel] of stem.channels.entries()) {
                const accumulator = target[channelIndex];
                for (let frame = 0; frame < frameCount; frame += 1) {
                    accumulator[frame] += channel[delay + frame];
                }
            }
        }
    }
    const passes = delays.length;
    const outputSampleRate = options?.outputSampleRate ?? info.sampleRate;
    return sums.map((channels, index) => {
        for (const channel of channels) {
            for (let frame = 0; frame < frameCount; frame += 1) {
                channel[frame] /= passes;
            }
        }
        return {
            track: layout.tracks[index],
            audio: resample(
                { sampleRate: layout.sampleRate, channels },
                outputSampleRate,
            ),
        };
    });
}

function layoutChannels(layout: DemucsLayout): 1 | 2 {
    if (layout.channels !== 1 && layout.channels !== 2) {
        throw new StemalignError(
            'unsupported-layout',
            `the demucs profile needs one or two channels, the model layout has ${layout.channels}`,
            {
                expected: '1 or 2 channels',
                actual: `${layout.channels} channels`,
            },
        );
    }
    return layout.channels;
}

async function runDemucs(
    session: ModelSession,
    layout: DemucsLayout,
    chunk: PcmAudio,
): Promise<readonly PcmAudio[]> {
    const frames = layout.frames;
    const data = new Float32Array(layout.channels * frames);
    for (const [index, channel] of chunk.channels.entries()) {
        data.set(channel, index * frames);
    }
    const input = new Tensor('float32', data, [1, layout.channels, frames]);
    const outputs = await session.run({ [layout.input]: input });
    const output = requireTensor(outputs, layout.output, {
        session: layout.session,
        expected: 'the declared output tensor',
        actual: Object.keys(outputs).join(', '),
    });
    try {
        return await readStems(output, layout);
    } finally {
        output.dispose();
    }
}

async function readStems(
    tensor: Tensor,
    layout: DemucsLayout,
): Promise<readonly PcmAudio[]> {
    const dims = tensor.dims;
    const expected = `[1, ${layout.stems}, ${layout.channels}, ${layout.frames}]`;
    if (
        dims.length !== 4 ||
        dims[0] !== 1 ||
        dims[1] !== layout.stems ||
        dims[2] !== layout.channels ||
        dims[3] !== layout.frames
    ) {
        throw new StemalignError(
            'model-invalid',
            `the model returned shape ${describeDims(dims)}, expected ${expected}`,
            {
                session: layout.session,
                tensor: layout.output,
                expected,
                actual: describeDims(dims),
            },
        );
    }
    const data = await readFloat32(tensor, layout);
    const perStem = layout.channels * layout.frames;
    const needed = layout.stems * perStem;
    if (data.length !== needed) {
        throw new StemalignError(
            'model-invalid',
            `the model returned ${data.length} samples, expected ${needed}`,
            {
                session: layout.session,
                tensor: layout.output,
                expected: `${needed} samples`,
                actual: `${data.length} samples`,
            },
        );
    }
    const stems: PcmAudio[] = [];
    for (let stem = 0; stem < layout.stems; stem += 1) {
        const channels: Float32Array[] = [];
        for (let channel = 0; channel < layout.channels; channel += 1) {
            const start = stem * perStem + channel * layout.frames;
            channels.push(data.slice(start, start + layout.frames));
        }
        stems.push({ sampleRate: layout.sampleRate, channels });
    }
    return stems;
}

async function readFloat32(
    tensor: Tensor,
    layout: DemucsLayout,
): Promise<Float32Array> {
    const data = await tensor.getData();
    if (tensor.type === 'float32') {
        if (data instanceof Float32Array) {
            return data;
        }
        throw dtypeError(layout, tensor.type, 'a Float32Array');
    }
    if (tensor.type === 'float16') {
        if (data instanceof Uint16Array) {
            return halfToFloat32(data);
        }
        throw dtypeError(layout, tensor.type, 'a Uint16Array');
    }
    throw dtypeError(layout, tensor.type, 'float32 or float16');
}

function dtypeError(
    layout: DemucsLayout,
    actual: string,
    expected: string,
): StemalignError {
    return new StemalignError(
        'unsupported-dtype',
        `the model returned dtype "${actual}", the demucs profile needs ${expected}`,
        {
            session: layout.session,
            tensor: layout.output,
            expected,
            actual,
        },
    );
}
