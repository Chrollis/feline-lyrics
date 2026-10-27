import type { InferenceSession, Tensor } from 'onnxruntime-node';

export type TensorType = Tensor.Type;

export type TensorShape = readonly (number | string)[];

export interface TensorInfo {
    readonly name: string;
    readonly type: TensorType;
    readonly shape: TensorShape;
}

export function toTensorInfos(
    metadata: readonly InferenceSession.ValueMetadata[],
): readonly TensorInfo[] {
    const infos: TensorInfo[] = [];
    for (const value of metadata) {
        if (!value.isTensor) {
            continue;
        }
        infos.push({ name: value.name, type: value.type, shape: value.shape });
    }
    return infos;
}
