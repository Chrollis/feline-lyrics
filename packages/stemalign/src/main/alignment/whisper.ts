import { StemalignError } from '../errors.js';
import type { TensorInfo, TensorShape } from '../model/info.js';
import type { ModelHandle, ModelSession } from '../model/session.js';

export const WHISPER_ENCODER_DOWNSAMPLE = 2;

const CACHE_INPUT_PATTERN =
    /^past_key_values\.(\d+)\.(decoder|encoder)\.(key|value)$/;
const CACHE_OUTPUT_PATTERN = /^present\.(\d+)\.(decoder|encoder)\.(key|value)$/;
const CROSS_ATTENTION_PATTERN = /^cross_attentions\.(\d+)$/;

export interface WhisperCachePair {
    readonly layer: number;
    readonly kind: 'decoder' | 'encoder';
    readonly key: TensorInfo;
    readonly value: TensorInfo;
}

export interface WhisperLayout {
    readonly encoder: string;
    readonly decoder: string;
    readonly melInput: TensorInfo;
    readonly hiddenState: TensorInfo;
    readonly inputIds: TensorInfo;
    readonly encoderStates: TensorInfo;
    readonly useCacheBranch: TensorInfo;
    readonly logits: TensorInfo;
    readonly crossAttentions: readonly TensorInfo[];
    readonly past: readonly WhisperCachePair[];
    readonly present: readonly WhisperCachePair[];
    readonly layers: number;
    readonly heads: number;
    readonly headDim: number;
    readonly vocabSize: number;
    readonly melBins: number | undefined;
}

export function inspectWhisper(handle: ModelHandle): WhisperLayout {
    const encoder = roleSession(handle, 'input_features', 'encoder');
    const decoder = roleSession(handle, 'input_ids', 'decoder');
    if (encoder.name === decoder.name) {
        throw new StemalignError(
            'model-invalid',
            `session "${encoder.name}" of model "${handle.id}" takes both "input_features" and "input_ids", the whisper profile needs one session each`,
            {
                modelId: handle.id,
                session: encoder.name,
                expected: 'a separate encoder and decoder session',
                actual: 'one session',
            },
        );
    }

    const melInput = requireTensor(
        handle,
        encoder,
        encoder.inputInfo,
        'input_features',
    );
    const hiddenState = selectTensor(
        handle,
        encoder,
        encoder.outputInfo,
        'last_hidden_state',
        (info) => info.shape.length === 3 && info.type === 'float32',
        'rank three float32 output',
    );
    const inputIds = requireTensor(
        handle,
        decoder,
        decoder.inputInfo,
        'input_ids',
    );
    const encoderStates = requireTensor(
        handle,
        decoder,
        decoder.inputInfo,
        'encoder_hidden_states',
    );
    const useCacheBranch = selectTensor(
        handle,
        decoder,
        decoder.inputInfo,
        'use_cache_branch',
        (info) => info.type === 'bool',
        'bool input',
    );
    const logits = selectTensor(
        handle,
        decoder,
        decoder.outputInfo,
        'logits',
        (info) => info.shape.length === 3 && info.type === 'float32',
        'rank three float32 output',
    );

    requireType(handle, melInput, 'float32');
    requireType(handle, hiddenState, 'float32');
    requireType(handle, inputIds, 'int64');
    requireType(handle, encoderStates, 'float32');
    requireType(handle, useCacheBranch, 'bool');
    requireType(handle, logits, 'float32');
    requireRank(handle, melInput, 3, 'mel');
    requireRank(handle, hiddenState, 3, 'hidden state');
    requireRank(handle, inputIds, 2, 'token');
    requireRank(handle, encoderStates, 3, 'hidden state');
    requireRank(handle, useCacheBranch, 1, 'cache branch');
    requireRank(handle, logits, 3, 'logits');
    checkBatch(handle, melInput);
    checkBatch(handle, hiddenState);
    checkBatch(handle, inputIds);
    checkBatch(handle, logits);
    const branchDim = requireDim(handle, useCacheBranch, 0, 'cache branch');
    if (branchDim !== 1) {
        throw new StemalignError(
            'model-invalid',
            `the cache branch input of model "${handle.id}" has ${branchDim} elements, the whisper profile needs one flag`,
            {
                modelId: handle.id,
                tensor: useCacheBranch.name,
                expected: '1',
                actual: `${branchDim}`,
            },
        );
    }

    const crossAttentions = attentionMaps(handle, decoder);
    const past = cachePairs(
        handle,
        decoder,
        decoder.inputInfo,
        CACHE_INPUT_PATTERN,
        'past cache',
    );
    const present = cachePairs(
        handle,
        decoder,
        decoder.outputInfo,
        CACHE_OUTPUT_PATTERN,
        'present cache',
    );
    const layers = crossAttentions.length;
    checkCacheCount(handle, 'past', past.length, layers);
    checkCacheCount(handle, 'present', present.length, layers);

    const heads = requireDim(handle, crossAttentions[0], 1, 'cross attention');
    for (const info of crossAttentions) {
        const other = requireDim(handle, info, 1, 'cross attention');
        if (other !== heads) {
            throw new StemalignError(
                'model-invalid',
                `cross attention tensors of model "${handle.id}" disagree on the number of heads: "${info.name}" has ${other}, expected ${heads}`,
                {
                    modelId: handle.id,
                    tensor: info.name,
                    expected: `${heads}`,
                    actual: `${other}`,
                },
            );
        }
    }
    const headDim = requireDim(handle, past[0].key, 3, 'cache');
    const dModel = requireDim(handle, hiddenState, 2, 'hidden state');
    if (heads * headDim !== dModel) {
        throw new StemalignError(
            'model-invalid',
            `model "${handle.id}" has ${heads} heads of size ${headDim}, which does not match the hidden size ${dModel}`,
            {
                modelId: handle.id,
                expected: `${heads} x ${headDim}`,
                actual: `${dModel}`,
            },
        );
    }
    const statesDim = encoderStates.shape[2];
    if (typeof statesDim === 'number' && statesDim !== dModel) {
        throw new StemalignError(
            'model-invalid',
            `the encoder states input of model "${handle.id}" has ${statesDim} features, expected ${dModel}`,
            {
                modelId: handle.id,
                tensor: encoderStates.name,
                expected: `${dModel}`,
                actual: `${statesDim}`,
            },
        );
    }

    const melBins = melInput.shape[1];
    return {
        encoder: encoder.name,
        decoder: decoder.name,
        melInput,
        hiddenState,
        inputIds,
        encoderStates,
        useCacheBranch,
        logits,
        crossAttentions,
        past,
        present,
        layers,
        heads,
        headDim,
        vocabSize: requireDim(handle, logits, 2, 'logits'),
        melBins: typeof melBins === 'number' ? melBins : undefined,
    };
}

function roleSession(
    handle: ModelHandle,
    inputName: string,
    role: string,
): ModelSession {
    const matches: ModelSession[] = [];
    for (const session of handle.sessions.values()) {
        for (const info of session.inputInfo) {
            if (info.name === inputName) {
                matches.push(session);
                break;
            }
        }
    }
    if (matches.length !== 1) {
        throw new StemalignError(
            'model-invalid',
            `the whisper profile needs exactly one ${role} session taking "${inputName}", model "${handle.id}" has ${matches.length}`,
            {
                modelId: handle.id,
                expected: `exactly one session with an "${inputName}" input`,
                actual: `${matches.length}`,
            },
        );
    }
    return matches[0];
}

function attentionMaps(
    handle: ModelHandle,
    session: ModelSession,
): readonly TensorInfo[] {
    const ordered = orderedByLayer(
        handle,
        collectLayers(session.outputInfo, CROSS_ATTENTION_PATTERN),
        'cross attention',
    );
    if (ordered.length === 0) {
        throw new StemalignError(
            'unknown-tensor',
            `session "${session.name}" of model "${handle.id}" exports no cross attention tensor, the whisper alignment profile cannot work without them`,
            {
                modelId: handle.id,
                session: session.name,
                tensor: 'cross_attentions.N',
                expected: 'one map per decoder layer',
                actual: 'none',
            },
        );
    }
    for (const info of ordered) {
        requireType(handle, info, 'float32');
        requireRank(handle, info, 4, 'cross attention');
        checkBatch(handle, info);
    }
    return ordered;
}

interface CacheSlot {
    readonly id: string;
    readonly layer: number;
    readonly kind: 'decoder' | 'encoder';
    key: TensorInfo | undefined;
    value: TensorInfo | undefined;
}

function cachePairs(
    handle: ModelHandle,
    session: ModelSession,
    infos: readonly TensorInfo[],
    pattern: RegExp,
    role: string,
): readonly WhisperCachePair[] {
    const slots = new Map<string, CacheSlot>();
    for (const info of infos) {
        const match = pattern.exec(info.name);
        if (match === null) {
            continue;
        }
        const layer = Number(match[1]);
        const kind = match[2] === 'decoder' ? 'decoder' : 'encoder';
        const id = `${layer}.${kind}`;
        let slot = slots.get(id);
        if (slot === undefined) {
            slot = { id, layer, kind, key: undefined, value: undefined };
            slots.set(id, slot);
        }
        if (match[3] === 'key') {
            slot.key = info;
        } else {
            slot.value = info;
        }
    }
    if (slots.size === 0) {
        throw new StemalignError(
            'unknown-tensor',
            `session "${session.name}" of model "${handle.id}" has no ${role} tensor, the whisper profile needs them`,
            {
                modelId: handle.id,
                session: session.name,
                expected: `${role} tensors`,
                actual: 'none',
            },
        );
    }
    const sorted = Array.from(slots.values()).sort(
        (left, right) => cacheOrder(left) - cacheOrder(right),
    );
    const pairs: WhisperCachePair[] = [];
    for (const [index, slot] of sorted.entries()) {
        if (cacheOrder(slot) !== index) {
            throw new StemalignError(
                'model-invalid',
                `model "${handle.id}" has ${role} tensors that do not cover every kind of every layer from 0 up: ${sorted
                    .map((item) => item.id)
                    .join(', ')}`,
                {
                    modelId: handle.id,
                    session: session.name,
                    expected: `${role} tensors for layers 0 to ${Math.floor(sorted.length / 2)}`,
                    actual: slot.id,
                },
            );
        }
        const key = slot.key;
        const value = slot.value;
        if (key === undefined || value === undefined) {
            throw new StemalignError(
                'model-invalid',
                `the ${role} slot "${slot.id}" of model "${handle.id}" is missing its ${key === undefined ? 'key' : 'value'} tensor`,
                {
                    modelId: handle.id,
                    session: session.name,
                    tensor: slot.id,
                    expected: 'a key and a value tensor',
                    actual: key === undefined ? 'value only' : 'key only',
                },
            );
        }
        for (const info of [key, value]) {
            requireType(handle, info, 'float32');
            requireRank(handle, info, 4, 'cache');
            checkBatch(handle, info);
        }
        pairs.push({ layer: slot.layer, kind: slot.kind, key, value });
    }
    return pairs;
}

function cacheOrder(slot: CacheSlot): number {
    return slot.layer * 2 + kindOrder(slot.kind);
}

function kindOrder(kind: 'decoder' | 'encoder'): number {
    return kind === 'decoder' ? 0 : 1;
}

interface LayerTensor {
    readonly layer: number;
    readonly info: TensorInfo;
}

function collectLayers(
    infos: readonly TensorInfo[],
    pattern: RegExp,
): readonly LayerTensor[] {
    const entries: LayerTensor[] = [];
    for (const info of infos) {
        const match = pattern.exec(info.name);
        if (match !== null) {
            entries.push({ layer: Number(match[1]), info });
        }
    }
    return entries;
}

function orderedByLayer(
    handle: ModelHandle,
    entries: readonly LayerTensor[],
    role: string,
): readonly TensorInfo[] {
    const ordered: TensorInfo[] = [];
    const sorted = [...entries].sort((left, right) => left.layer - right.layer);
    for (const entry of sorted) {
        if (entry.layer !== ordered.length) {
            throw new StemalignError(
                'model-invalid',
                `model "${handle.id}" has ${role} tensors for layers ${sorted.map((item) => String(item.layer)).join(', ')}, the whisper profile needs a contiguous range starting at 0`,
                {
                    modelId: handle.id,
                    expected: `layers 0 to ${sorted.length - 1}`,
                    actual: sorted.map((item) => String(item.layer)).join(', '),
                },
            );
        }
        ordered.push(entry.info);
    }
    return ordered;
}

function checkCacheCount(
    handle: ModelHandle,
    role: string,
    count: number,
    layers: number,
): void {
    if (count !== layers * 2) {
        throw new StemalignError(
            'model-invalid',
            `model "${handle.id}" exports ${layers} cross attention maps but ${count} ${role} tensors, expected ${layers * 2}`,
            {
                modelId: handle.id,
                expected: `${layers * 2}`,
                actual: `${count}`,
            },
        );
    }
}

function requireTensor(
    handle: ModelHandle,
    session: ModelSession,
    infos: readonly TensorInfo[],
    name: string,
): TensorInfo {
    for (const info of infos) {
        if (info.name === name) {
            return info;
        }
    }
    throw new StemalignError(
        'unknown-tensor',
        `session "${session.name}" of model "${handle.id}" has no "${name}" tensor`,
        {
            modelId: handle.id,
            session: session.name,
            tensor: name,
            expected: name,
            actual: infos.map((info) => info.name).join(', '),
        },
    );
}

function selectTensor(
    handle: ModelHandle,
    session: ModelSession,
    infos: readonly TensorInfo[],
    name: string,
    matches: (info: TensorInfo) => boolean,
    role: string,
): TensorInfo {
    for (const info of infos) {
        if (info.name === name) {
            return info;
        }
    }
    const candidates = infos.filter(matches);
    if (candidates.length === 1) {
        return candidates[0];
    }
    throw new StemalignError(
        'unknown-tensor',
        `session "${session.name}" of model "${handle.id}" has no "${name}" tensor and ${candidates.length} tensors look like a ${role}`,
        {
            modelId: handle.id,
            session: session.name,
            tensor: name,
            expected: `"${name}" or exactly one ${role}`,
            actual: `${candidates.length} candidates`,
        },
    );
}

function requireType(
    handle: ModelHandle,
    info: TensorInfo,
    expected: TensorInfo['type'],
): void {
    if (info.type !== expected) {
        throw new StemalignError(
            'unsupported-dtype',
            `tensor "${info.name}" of model "${handle.id}" has type "${info.type}", the whisper profile needs "${expected}"`,
            {
                modelId: handle.id,
                tensor: info.name,
                expected: `${expected}`,
                actual: `${info.type}`,
            },
        );
    }
}

function requireRank(
    handle: ModelHandle,
    info: TensorInfo,
    rank: number,
    role: string,
): void {
    if (info.shape.length !== rank) {
        throw new StemalignError(
            'model-invalid',
            `the ${role} tensor "${info.name}" of model "${handle.id}" has shape ${describeShape(info.shape)}, the whisper profile needs rank ${rank}`,
            {
                modelId: handle.id,
                tensor: info.name,
                expected: `rank ${rank}`,
                actual: describeShape(info.shape),
            },
        );
    }
}

function requireDim(
    handle: ModelHandle,
    info: TensorInfo,
    index: number,
    role: string,
): number {
    const dim = info.shape[index];
    if (typeof dim !== 'number') {
        throw new StemalignError(
            'missing-setting',
            `dimension ${index} of the ${role} tensor "${info.name}" of model "${handle.id}" is symbolic ("${String(dim)}"), the whisper profile needs a fixed value`,
            {
                modelId: handle.id,
                tensor: info.name,
                expected: `a fixed dimension ${index}`,
                actual: String(dim),
            },
        );
    }
    return dim;
}

function checkBatch(handle: ModelHandle, info: TensorInfo): void {
    const dim = info.shape[0];
    if (typeof dim === 'number' && dim !== 1) {
        throw new StemalignError(
            'model-invalid',
            `tensor "${info.name}" of model "${handle.id}" has batch size ${dim}, the whisper profile runs one sample at a time`,
            {
                modelId: handle.id,
                tensor: info.name,
                expected: '1',
                actual: `${dim}`,
            },
        );
    }
}

function describeShape(shape: TensorShape): string {
    return `[${shape.map((dim) => String(dim)).join(', ')}]`;
}
