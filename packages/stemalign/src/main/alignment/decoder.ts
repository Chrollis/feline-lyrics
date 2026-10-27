import { Tensor } from 'onnxruntime-node';
import type { InferenceSession } from 'onnxruntime-node';
import { StemalignError } from '../errors.js';
import { requireSession, type ModelHandle } from '../model/session.js';
import { describeDims, describeDtype, requireTensor } from '../model/tensor.js';
import type { WhisperLayout } from './whisper.js';
import type { WhisperSettings } from './settings.js';

export interface DecoderAttention {
    readonly layer: number;
    readonly head: number;
    readonly tokens: number;
    readonly frames: number;
    readonly values: Float32Array;
}

export interface DecoderPass {
    readonly tokens: number;
    readonly frames: number;
    /**
     * One probability per emitted token except the first one: entry `row`
     * belongs to `tokenIds[row + 1]`. The text tokens of a window therefore
     * start at the row that follows the prefix tokens.
     */
    readonly probabilities: Float64Array;
    readonly attentions: readonly DecoderAttention[];
}

export interface DecoderRequest {
    readonly hiddenStates: Float32Array;
    readonly tokenIds: readonly number[];
}

export async function runDecoder(
    handle: ModelHandle,
    layout: WhisperLayout,
    settings: WhisperSettings,
    request: DecoderRequest,
): Promise<DecoderPass> {
    const session = requireSession(handle, layout.decoder);
    const modelSize = layout.heads * layout.headDim;
    const frames = settings.maxSourcePositions;
    if (request.hiddenStates.length !== frames * modelSize) {
        throw new StemalignError(
            'invalid-option',
            `encoder hidden states must hold ${frames * modelSize} values (${frames} frames of ${modelSize}), got ${request.hiddenStates.length}`,
            { actual: String(request.hiddenStates.length) },
        );
    }
    const tokens = request.tokenIds.length;
    if (tokens < 1 || tokens > settings.maxTargetPositions) {
        throw new StemalignError(
            'invalid-option',
            `decoder sequence must hold between 1 and ${settings.maxTargetPositions} tokens, got ${tokens}`,
            { actual: String(tokens) },
        );
    }

    const output = await session.run(
        buildFeeds(layout, request, frames, modelSize),
        buildFetches(layout, settings),
    );
    // A logits tensor is [1, tokens, vocabSize] float32, which is about 93 MB
    // for a 400 token window, and nothing downstream wants more than one
    // probability per text token, so read those out and release the tensor
    // instead of keeping it alive for the lifetime of the pass.
    const probabilities = readProbabilities(
        output,
        layout,
        settings,
        tokens,
        request.tokenIds,
    );
    return {
        tokens,
        frames,
        probabilities,
        attentions: readAttentions(output, layout, settings, tokens, frames),
    };
}

/**
 * Probability that the decoder emitted each token except the first one, indexed
 * so that entry `row` belongs to `tokenIds[row + 1]`.
 *
 * The softmax of a row only covers ids below the end of text token, and ids
 * outside that range (special and timestamp tokens) score zero. That is what
 * extractTextTokenProbs does in the reference
 * (reference/whisper/src/inference-func.mjs:305).
 */
export function emittedTokenProbabilities(
    logits: Float32Array,
    vocabSize: number,
    eot: number,
    tokenIds: readonly number[],
): Float64Array {
    if (vocabSize <= 0 || eot <= 0 || eot > vocabSize) {
        throw new StemalignError(
            'invalid-option',
            `the end of text token must fall inside 1..${vocabSize}, got ${eot}`,
            { expected: `a token id in 1..${vocabSize}`, actual: String(eot) },
        );
    }
    if (tokenIds.length < 1) {
        throw new StemalignError(
            'invalid-option',
            'the token sequence must hold at least one token',
            { actual: String(tokenIds.length) },
        );
    }
    const values = tokenIds.length * vocabSize;
    if (logits.length !== values) {
        throw new StemalignError(
            'invalid-option',
            `the logits must hold ${values} values (${tokenIds.length} rows of ${vocabSize}), got ${logits.length}`,
            { expected: String(values), actual: String(logits.length) },
        );
    }

    const probabilities = new Float64Array(tokenIds.length - 1);
    for (let row = 0; row < probabilities.length; row += 1) {
        const base = row * vocabSize;
        let maximum = -Infinity;
        for (let id = 0; id < eot; id += 1) {
            const value = logits[base + id];
            if (value > maximum) {
                maximum = value;
            }
        }
        let total = 0;
        for (let id = 0; id < eot; id += 1) {
            total += Math.exp(logits[base + id] - maximum);
        }
        const emitted = tokenIds[row + 1];
        if (emitted < 0 || emitted >= eot) {
            continue;
        }
        probabilities[row] = Math.exp(logits[base + emitted] - maximum) / total;
    }
    return probabilities;
}

function readProbabilities(
    output: InferenceSession.ReturnType,
    layout: WhisperLayout,
    settings: WhisperSettings,
    tokens: number,
    tokenIds: readonly number[],
): Float64Array {
    const tensor = requireTensor(output, layout.logits.name);
    try {
        const data = tensor.data;
        if (!(data instanceof Float32Array)) {
            throw new StemalignError(
                'unsupported-dtype',
                `${layout.logits.name} must be float32`,
                { tensor: layout.logits.name, actual: describeDtype(data) },
            );
        }
        const dims = tensor.dims;
        if (
            dims.length !== 3 ||
            dims[0] !== 1 ||
            dims[1] !== tokens ||
            dims[2] !== settings.vocabSize
        ) {
            throw new StemalignError(
                'model-invalid',
                `${layout.logits.name} has shape ${describeDims(dims)}, expected [1, ${tokens}, ${settings.vocabSize}]`,
                { tensor: layout.logits.name, actual: describeDims(dims) },
            );
        }
        return emittedTokenProbabilities(
            data,
            settings.vocabSize,
            settings.eosTokenId,
            tokenIds,
        );
    } finally {
        tensor.dispose();
    }
}

function buildFeeds(
    layout: WhisperLayout,
    request: DecoderRequest,
    frames: number,
    modelSize: number,
): InferenceSession.FeedsType {
    const feeds: Record<string, Tensor> = {
        [layout.inputIds.name]: new Tensor(
            'int64',
            BigInt64Array.from(request.tokenIds.map((id) => BigInt(id))),
            [1, request.tokenIds.length],
        ),
        [layout.encoderStates.name]: new Tensor(
            'float32',
            request.hiddenStates,
            [1, frames, modelSize],
        ),
        // Always false: see the note on the past placeholders below.
        [layout.useCacheBranch.name]: new Tensor(
            'bool',
            Uint8Array.from([0]),
            [1],
        ),
    };
    // v1 never generates tokens, so no multi-step cached decode is needed. The
    // merged export wraps the whole graph in one If node keyed on
    // use_cache_branch, and ORT cannot run consecutive cached calls on it: a
    // second cached pass with a longer decoder past trips ReshapeHelper inside
    // /model/decoder/layers.0/encoder_attn/Reshape_4. We always take the else
    // branch, where every past input is dead (feeding random values changes
    // nothing), so zero length placeholders are enough. The encoder
    // placeholders stay at zero length too: the else branch recomputes the
    // encoder keys and values from encoder_hidden_states.
    for (const pair of layout.past) {
        const shape = [1, layout.heads, 0, layout.headDim];
        feeds[pair.key.name] = new Tensor(
            'float32',
            new Float32Array(0),
            shape,
        );
        feeds[pair.value.name] = new Tensor(
            'float32',
            new Float32Array(0),
            shape,
        );
    }
    return feeds;
}

function buildFetches(
    layout: WhisperLayout,
    settings: WhisperSettings,
): readonly string[] {
    const layers = new Set<number>();
    for (const head of settings.alignmentHeads) {
        layers.add(head.layer);
    }
    const names: string[] = [];
    for (const layer of [...layers].sort((left, right) => left - right)) {
        const info = layout.crossAttentions[layer];
        if (info === undefined) {
            throw new StemalignError(
                'setting-mismatch',
                `decoder has no cross_attentions.${layer}`,
                {
                    tensor: `cross_attentions.${layer}`,
                    expected: `a layer between 0 and ${layout.crossAttentions.length - 1}`,
                },
            );
        }
        names.push(info.name);
    }
    names.push(layout.logits.name);
    return names;
}

function readAttentions(
    output: InferenceSession.ReturnType,
    layout: WhisperLayout,
    settings: WhisperSettings,
    tokens: number,
    frames: number,
): readonly DecoderAttention[] {
    const tensors = new Map<number, Tensor>();
    const attentions: DecoderAttention[] = [];
    try {
        for (const head of settings.alignmentHeads) {
            let tensor = tensors.get(head.layer);
            if (tensor === undefined) {
                tensor = requireTensor(
                    output,
                    layout.crossAttentions[head.layer].name,
                );
                tensors.set(head.layer, tensor);
            }
            const data = tensor.data;
            if (!(data instanceof Float32Array)) {
                throw new StemalignError(
                    'unsupported-dtype',
                    `cross_attentions.${head.layer} must be float32`,
                    {
                        tensor: `cross_attentions.${head.layer}`,
                        actual: describeDtype(data),
                    },
                );
            }
            const dims = tensor.dims;
            if (
                dims.length !== 4 ||
                dims[0] !== 1 ||
                dims[1] !== layout.heads ||
                dims[2] !== tokens ||
                dims[3] !== frames
            ) {
                throw new StemalignError(
                    'model-invalid',
                    `cross_attentions.${head.layer} has shape ${describeDims(dims)}, expected [1, ${layout.heads}, ${tokens}, ${frames}]`,
                    {
                        tensor: `cross_attentions.${head.layer}`,
                        actual: describeDims(dims),
                    },
                );
            }
            const values = new Float32Array(tokens * frames);
            for (let index = 0; index < tokens; index += 1) {
                const start = (head.head * tokens + index) * frames;
                values.set(
                    data.subarray(start, start + frames),
                    index * frames,
                );
            }
            attentions.push({
                layer: head.layer,
                head: head.head,
                tokens,
                frames,
                values,
            });
        }
    } finally {
        for (const tensor of tensors.values()) {
            tensor.dispose();
        }
    }
    return attentions;
}
