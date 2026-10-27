import { Tensor } from 'onnxruntime-node';
import type { InferenceSession } from 'onnxruntime-node';
import { StemalignError } from '../errors.js';
import type { StemalignErrorContext } from '../errors.js';

export function requireTensor(
    output: InferenceSession.ReturnType,
    name: string,
    context: StemalignErrorContext = {},
): Tensor {
    const raw: unknown = output[name];
    if (!(raw instanceof Tensor)) {
        throw new StemalignError(
            'unknown-tensor',
            `the session did not produce the output "${name}"`,
            { ...context, tensor: name },
        );
    }
    return raw;
}

export function describeDims(dims: readonly number[]): string {
    return `[${dims.join(', ')}]`;
}

export function describeDtype(data: unknown): string {
    if (data instanceof Float32Array) {
        return 'float32';
    }
    if (data instanceof Uint16Array) {
        return 'float16';
    }
    if (data instanceof BigInt64Array) {
        return 'int64';
    }
    if (data instanceof Uint8Array) {
        return 'bool or uint8';
    }
    if (data instanceof Int32Array) {
        return 'int32';
    }
    return data === undefined ? 'none' : 'other';
}
