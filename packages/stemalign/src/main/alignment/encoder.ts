import { Tensor } from 'onnxruntime-node';
import { StemalignError } from '../errors.js';
import { halfToFloat32 } from '../model/half.js';
import { requireSession, type ModelHandle } from '../model/session.js';
import { describeDims, describeDtype, requireTensor } from '../model/tensor.js';
import type { MelBlock } from './mel.js';
import type { WhisperLayout } from './whisper.js';
import type { WhisperSettings } from './settings.js';

export async function runEncoder(
    handle: ModelHandle,
    layout: WhisperLayout,
    settings: WhisperSettings,
    mel: MelBlock,
): Promise<Float32Array> {
    const session = requireSession(handle, layout.encoder);
    if (
        mel.melBins !== settings.melBins ||
        mel.frames !== settings.nbMaxFrames
    ) {
        throw new StemalignError(
            'invalid-option',
            `encoder expects a mel block of ${settings.melBins} bins and ${settings.nbMaxFrames} frames, got ${mel.melBins} bins and ${mel.frames} frames`,
            { actual: `${mel.melBins} bins and ${mel.frames} frames` },
        );
    }
    if (mel.values.length !== mel.melBins * mel.frames) {
        throw new StemalignError(
            'invalid-option',
            `mel block must hold ${mel.melBins * mel.frames} values, got ${mel.values.length}`,
            { actual: String(mel.values.length) },
        );
    }

    const modelSize = layout.heads * layout.headDim;
    const frames = settings.maxSourcePositions;
    const output = await session.run(
        {
            [layout.melInput.name]: new Tensor('float32', mel.values, [
                1,
                mel.melBins,
                mel.frames,
            ]),
        },
        [layout.hiddenState.name],
    );

    const tensor = requireTensor(output, layout.hiddenState.name);
    // The caller keeps these values for the rest of the window, so copy them
    // out and release the output tensor here: [1, frames, modelSize] float32 is
    // about 6 MB per window, and holding one per window is exactly how a long
    // run grows without bound.
    try {
        const dims = tensor.dims;
        if (
            dims.length !== 3 ||
            dims[0] !== 1 ||
            dims[1] !== frames ||
            dims[2] !== modelSize
        ) {
            throw new StemalignError(
                'model-invalid',
                `${layout.hiddenState.name} has shape ${describeDims(dims)}, expected [1, ${frames}, ${modelSize}]`,
                { tensor: layout.hiddenState.name, actual: describeDims(dims) },
            );
        }
        const data = tensor.data;
        if (data instanceof Float32Array) {
            return new Float32Array(data);
        }
        if (data instanceof Uint16Array) {
            return halfToFloat32(data);
        }
        throw new StemalignError(
            'unsupported-dtype',
            `${layout.hiddenState.name} must be float32 or float16`,
            { tensor: layout.hiddenState.name, actual: describeDtype(data) },
        );
    } finally {
        tensor.dispose();
    }
}
