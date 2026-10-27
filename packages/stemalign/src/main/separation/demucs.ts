import { StemalignError } from '../errors.js';
import type { TensorInfo, TensorShape } from '../model/info.js';
import type { ModelHandle, ModelSession } from '../model/session.js';

export const DEMUCS_SAMPLE_RATE = 44100;
export const DEMUCS_OVERLAP = 0.25;
export const DEMUCS_SHIFTS = 1;

const DEMUCS_TRACKS = [
    'drums',
    'bass',
    'other',
    'vocals',
    'guitar',
    'piano',
] as const;

export interface DemucsLayout {
    readonly session: string;
    readonly input: string;
    readonly output: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly frames: number;
    readonly stems: number;
    readonly tracks: readonly string[];
}

export function inspectDemucs(
    handle: ModelHandle,
    tracks?: readonly string[],
): DemucsLayout {
    const session = singleSession(handle);
    const input = singleTensor(handle, session.inputInfo, 'input');
    const output = singleTensor(handle, session.outputInfo, 'output');
    if (input.type !== 'float32') {
        throw new StemalignError(
            'unsupported-dtype',
            `input "${input.name}" of model "${handle.id}" has type "${input.type}", the demucs profile feeds float32`,
            {
                modelId: handle.id,
                session: session.name,
                tensor: input.name,
                expected: 'float32',
                actual: input.type,
            },
        );
    }
    if (output.type !== 'float32' && output.type !== 'float16') {
        throw new StemalignError(
            'unsupported-dtype',
            `output "${output.name}" of model "${handle.id}" has type "${output.type}", the demucs profile reads float32 or float16`,
            {
                modelId: handle.id,
                session: session.name,
                tensor: output.name,
                expected: 'float32 or float16',
                actual: output.type,
            },
        );
    }
    const inputDims = fixedDims(handle, input);
    const outputDims = fixedDims(handle, output);
    if (inputDims.length !== 3 || inputDims[0] !== 1 || inputDims[1] !== 2) {
        throw shapeError(handle, input, '[1, 2, frames]');
    }
    const frames = inputDims[2];
    if (
        outputDims.length !== 4 ||
        outputDims[0] !== 1 ||
        outputDims[2] !== 2 ||
        outputDims[3] !== frames
    ) {
        throw shapeError(handle, output, `[1, stems, 2, ${frames}]`);
    }
    const stems = outputDims[1];
    if (stems < 1) {
        throw new StemalignError(
            'model-invalid',
            `output "${output.name}" of model "${handle.id}" produces ${stems} stems`,
            {
                modelId: handle.id,
                session: session.name,
                tensor: output.name,
                expected: 'at least one stem',
                actual: `${stems}`,
            },
        );
    }
    const names = resolveTracks(handle, stems, tracks);
    return {
        session: session.name,
        input: input.name,
        output: output.name,
        sampleRate: DEMUCS_SAMPLE_RATE,
        channels: 2,
        frames,
        stems,
        tracks: names,
    };
}

function singleSession(handle: ModelHandle): ModelSession {
    const sessions = Array.from(handle.sessions.values());
    if (sessions.length !== 1) {
        throw new StemalignError(
            'model-invalid',
            `the demucs profile needs exactly one session, model "${handle.id}" has ${sessions.length}`,
            {
                modelId: handle.id,
                expected: 'exactly one session',
                actual: `${sessions.length}`,
            },
        );
    }
    return sessions[0];
}

function singleTensor(
    handle: ModelHandle,
    infos: readonly TensorInfo[],
    role: string,
): TensorInfo {
    if (infos.length !== 1) {
        throw new StemalignError(
            'model-invalid',
            `the demucs profile needs exactly one ${role} tensor, model "${handle.id}" has ${infos.length}`,
            {
                modelId: handle.id,
                expected: `exactly one ${role} tensor`,
                actual: `${infos.length}`,
            },
        );
    }
    return infos[0];
}

function fixedDims(handle: ModelHandle, info: TensorInfo): readonly number[] {
    const dims: number[] = [];
    for (const [index, dim] of info.shape.entries()) {
        if (typeof dim !== 'number') {
            throw new StemalignError(
                'missing-setting',
                `dimension ${index} of tensor "${info.name}" of model "${handle.id}" is symbolic ("${dim}"), the demucs profile needs a fixed shape`,
                {
                    modelId: handle.id,
                    tensor: info.name,
                    expected: 'a fixed dimension',
                    actual: String(dim),
                },
            );
        }
        dims.push(dim);
    }
    return dims;
}

function shapeError(
    handle: ModelHandle,
    info: TensorInfo,
    expected: string,
): StemalignError {
    return new StemalignError(
        'model-invalid',
        `tensor "${info.name}" of model "${handle.id}" has shape ${describeShape(info.shape)}, the demucs profile needs ${expected}`,
        {
            modelId: handle.id,
            tensor: info.name,
            expected,
            actual: describeShape(info.shape),
        },
    );
}

function describeShape(shape: TensorShape): string {
    return `[${shape.map((dim) => String(dim)).join(', ')}]`;
}

function resolveTracks(
    handle: ModelHandle,
    stems: number,
    tracks: readonly string[] | undefined,
): readonly string[] {
    if (tracks !== undefined) {
        if (tracks.length !== stems) {
            throw new StemalignError(
                'setting-mismatch',
                `model "${handle.id}" produces ${stems} stems but ${tracks.length} track names were given`,
                {
                    modelId: handle.id,
                    expected: `${stems} track names`,
                    actual: `${tracks.length}`,
                },
            );
        }
        return tracks;
    }
    if (stems === 4 || stems === 6) {
        return DEMUCS_TRACKS.slice(0, stems);
    }
    throw new StemalignError(
        'missing-setting',
        `model "${handle.id}" produces ${stems} stems, which is not one of the demucs conventions (4 or 6), so the track names must be given`,
        {
            modelId: handle.id,
            expected: '4 or 6 stems, or explicit track names',
            actual: `${stems} stems`,
        },
    );
}
