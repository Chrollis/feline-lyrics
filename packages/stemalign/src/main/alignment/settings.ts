import { StemalignError } from '../errors.js';
import type { ModelHandle } from '../model/session.js';
import { WHISPER_ENCODER_DOWNSAMPLE } from './whisper.js';
import type { WhisperLayout } from './whisper.js';

const CONFIG = 'config';
const GENERATION = 'generation';
const PREPROCESSOR = 'preprocessor';

export interface AlignmentHead {
    readonly layer: number;
    readonly head: number;
}

export interface WhisperSettings {
    readonly sampleRate: number;
    readonly melBins: number;
    readonly nFft: number;
    readonly hopLength: number;
    readonly chunkLength: number;
    readonly nbMaxFrames: number;
    readonly nSamples: number;
    readonly maxSourcePositions: number;
    readonly maxTargetPositions: number;
    readonly vocabSize: number;
    readonly medianFilterWidth: number;
    readonly decoderStartTokenId: number;
    readonly eosTokenId: number;
    readonly noTimestampsTokenId: number;
    readonly beginSuppressTokens: readonly number[];
    readonly suppressTokens: readonly number[];
    readonly alignmentHeads: readonly AlignmentHead[];
    readonly languageIds: Readonly<Record<string, number>>;
    readonly taskIds: Readonly<Record<string, number>>;
}

export function inspectWhisperSettings(
    handle: ModelHandle,
    layout: WhisperLayout,
): WhisperSettings {
    const config = parseSetting(handle, CONFIG);
    const generation = parseSetting(handle, GENERATION);
    const preprocessor = parseSetting(handle, PREPROCESSOR);

    const sampleRate = integerSetting(preprocessor, 'sampling_rate');
    const hopLength = integerSetting(preprocessor, 'hop_length');
    const nFft = integerSetting(preprocessor, 'n_fft');
    const featureSize = integerSetting(preprocessor, 'feature_size');
    const chunkLength = integerSetting(preprocessor, 'chunk_length');
    const nbMaxFrames = integerSetting(preprocessor, 'nb_max_frames');
    const nSamples = integerSetting(preprocessor, 'n_samples');

    const dModel = integerSetting(config, 'd_model');
    const layers = integerSetting(config, 'decoder_layers');
    const heads = integerSetting(config, 'decoder_attention_heads');
    const melBins = integerSetting(config, 'num_mel_bins');
    const vocabSize = integerSetting(config, 'vocab_size');
    const maxSourcePositions = integerSetting(config, 'max_source_positions');
    const maxTargetPositions = integerSetting(config, 'max_target_positions');
    const medianFilterWidth = integerSetting(config, 'median_filter_width');
    const decoderStartTokenId = integerSetting(
        config,
        'decoder_start_token_id',
    );
    const eosTokenId = integerSetting(config, 'eos_token_id');
    const beginSuppressTokens = integerValues(config, 'begin_suppress_tokens');

    const suppressTokens = optionalIntegerValues(generation, 'suppress_tokens');
    const noTimestampsTokenId = integerSetting(
        generation,
        'no_timestamps_token_id',
    );
    const languageIds = integerMap(generation, 'lang_to_id');
    const taskIds = integerMap(generation, 'task_to_id');
    const alignmentHeads = readAlignmentHeads(generation, layers, heads);

    matchValues(
        handle.id,
        'num_mel_bins',
        melBins,
        '"feature_size"',
        featureSize,
    );
    matchValues(
        handle.id,
        'decoder_layers',
        layers,
        'the model decoder',
        layout.layers,
    );
    matchValues(
        handle.id,
        'decoder_attention_heads',
        heads,
        'the model decoder',
        layout.heads,
    );
    matchValues(
        handle.id,
        'vocab_size',
        vocabSize,
        'the model logits',
        layout.vocabSize,
    );
    matchValues(
        handle.id,
        'd_model',
        dModel,
        'the model heads',
        layout.heads * layout.headDim,
    );
    if (layout.melBins !== undefined) {
        matchValues(
            handle.id,
            'num_mel_bins',
            melBins,
            'the model mel input',
            layout.melBins,
        );
    }
    if (nbMaxFrames * hopLength !== chunkLength * sampleRate) {
        throw new StemalignError(
            'setting-mismatch',
            `setting "nb_max_frames" of model "${handle.id}" is ${nbMaxFrames}, which is not ${chunkLength} seconds at ${sampleRate} Hz with a hop of ${hopLength}`,
            {
                modelId: handle.id,
                expected: `${(chunkLength * sampleRate) / hopLength}`,
                actual: `${nbMaxFrames}`,
            },
        );
    }
    if (nSamples !== sampleRate * chunkLength) {
        throw new StemalignError(
            'setting-mismatch',
            `setting "n_samples" of model "${handle.id}" is ${nSamples}, expected ${sampleRate * chunkLength} for ${chunkLength} seconds at ${sampleRate} Hz`,
            {
                modelId: handle.id,
                expected: `${sampleRate * chunkLength}`,
                actual: `${nSamples}`,
            },
        );
    }
    if (maxSourcePositions * WHISPER_ENCODER_DOWNSAMPLE !== nbMaxFrames) {
        throw new StemalignError(
            'setting-mismatch',
            `setting "max_source_positions" of model "${handle.id}" is ${maxSourcePositions}, but ${nbMaxFrames} mel frames need ${nbMaxFrames / WHISPER_ENCODER_DOWNSAMPLE} positions at a downsample factor of ${WHISPER_ENCODER_DOWNSAMPLE}`,
            {
                modelId: handle.id,
                expected: `${nbMaxFrames / WHISPER_ENCODER_DOWNSAMPLE}`,
                actual: `${maxSourcePositions}`,
            },
        );
    }

    return {
        sampleRate,
        melBins,
        nFft,
        hopLength,
        chunkLength,
        nbMaxFrames,
        nSamples,
        maxSourcePositions,
        maxTargetPositions,
        vocabSize,
        medianFilterWidth,
        decoderStartTokenId,
        eosTokenId,
        noTimestampsTokenId,
        beginSuppressTokens,
        suppressTokens,
        alignmentHeads,
        languageIds,
        taskIds,
    };
}

interface SettingSource {
    readonly label: string;
    readonly modelId: string;
    readonly values: Record<string, unknown>;
}

function parseSetting(handle: ModelHandle, key: string): SettingSource {
    const text = handle.settings[key];
    if (text === undefined) {
        throw new StemalignError(
            'missing-setting',
            `model "${handle.id}" has no "${key}" setting, the whisper profile needs the ${key}.json file as text`,
            {
                modelId: handle.id,
                expected: `the "${key}" setting`,
                actual: Object.keys(handle.settings).join(', ') || 'none',
            },
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new StemalignError(
            'missing-setting',
            `the "${key}" setting of model "${handle.id}" is not valid JSON`,
            {
                modelId: handle.id,
                expected: `valid JSON in "${key}"`,
                actual: 'unparsable',
            },
            { cause: error },
        );
    }
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new StemalignError(
            'missing-setting',
            `the "${key}" setting of model "${handle.id}" is not a JSON object`,
            {
                modelId: handle.id,
                expected: `a JSON object in "${key}"`,
                actual: typeof parsed,
            },
        );
    }
    const values: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(parsed)) {
        values[name] = value;
    }
    return { label: key, modelId: handle.id, values };
}

function integerSetting(source: SettingSource, key: string): number {
    const value = source.values[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new StemalignError(
            'missing-setting',
            `setting "${source.label}" of model "${source.modelId}" has no integer "${key}"`,
            {
                modelId: source.modelId,
                expected: `an integer "${key}" in "${source.label}"`,
                actual: describeValue(value),
            },
        );
    }
    return value;
}

function integerValues(source: SettingSource, key: string): readonly number[] {
    const value = source.values[key];
    if (!Array.isArray(value)) {
        throw new StemalignError(
            'missing-setting',
            `setting "${source.label}" of model "${source.modelId}" has no "${key}" array`,
            {
                modelId: source.modelId,
                expected: `an array "${key}" in "${source.label}"`,
                actual: describeValue(value),
            },
        );
    }
    const numbers: number[] = [];
    for (const entry of value) {
        if (typeof entry !== 'number' || !Number.isInteger(entry)) {
            throw new StemalignError(
                'missing-setting',
                `setting "${source.label}" of model "${source.modelId}" has a non integer entry in "${key}"`,
                {
                    modelId: source.modelId,
                    expected: `integers in "${key}"`,
                    actual: describeValue(entry),
                },
            );
        }
        numbers.push(entry);
    }
    return numbers;
}

function optionalIntegerValues(
    source: SettingSource,
    key: string,
): readonly number[] {
    if (source.values[key] === undefined) {
        return [];
    }
    return integerValues(source, key);
}

function integerMap(
    source: SettingSource,
    key: string,
): Readonly<Record<string, number>> {
    const value = source.values[key];
    if (value === undefined) {
        return {};
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new StemalignError(
            'missing-setting',
            `setting "${source.label}" of model "${source.modelId}" has no "${key}" object`,
            {
                modelId: source.modelId,
                expected: `an object "${key}" in "${source.label}"`,
                actual: describeValue(value),
            },
        );
    }
    const map: Record<string, number> = {};
    for (const [name, entry] of Object.entries(value)) {
        if (typeof entry !== 'number' || !Number.isInteger(entry)) {
            throw new StemalignError(
                'missing-setting',
                `setting "${source.label}" of model "${source.modelId}" has a non integer entry in "${key}"`,
                {
                    modelId: source.modelId,
                    expected: `integer ids in "${key}"`,
                    actual: `${name}: ${describeValue(entry)}`,
                },
            );
        }
        map[name] = entry;
    }
    return map;
}

function readAlignmentHeads(
    source: SettingSource,
    layers: number,
    heads: number,
): readonly AlignmentHead[] {
    const value = source.values['alignment_heads'];
    if (!Array.isArray(value)) {
        throw new StemalignError(
            'missing-setting',
            `setting "${source.label}" of model "${source.modelId}" has no "alignment_heads" array`,
            {
                modelId: source.modelId,
                expected: 'an "alignment_heads" array',
                actual: describeValue(value),
            },
        );
    }
    const entries: AlignmentHead[] = [];
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2) {
            throw new StemalignError(
                'missing-setting',
                `setting "${source.label}" of model "${source.modelId}" has a malformed "alignment_heads" entry`,
                {
                    modelId: source.modelId,
                    expected: 'a pair of a layer and a head',
                    actual: describeValue(entry),
                },
            );
        }
        const layer = entry[0];
        const head = entry[1];
        if (
            typeof layer !== 'number' ||
            typeof head !== 'number' ||
            !Number.isInteger(layer) ||
            !Number.isInteger(head)
        ) {
            throw new StemalignError(
                'missing-setting',
                `setting "${source.label}" of model "${source.modelId}" has a non integer "alignment_heads" entry`,
                {
                    modelId: source.modelId,
                    expected: 'integers in "alignment_heads"',
                    actual: describeValue(entry),
                },
            );
        }
        if (layer < 0 || layer >= layers || head < 0 || head >= heads) {
            throw new StemalignError(
                'setting-mismatch',
                `model "${source.modelId}" declares alignment head (${layer}, ${head}), outside the ${layers} layers and ${heads} heads of its decoder`,
                {
                    modelId: source.modelId,
                    expected: `layer < ${layers} and head < ${heads}`,
                    actual: `(${layer}, ${head})`,
                },
            );
        }
        entries.push({ layer, head });
    }
    if (entries.length === 0) {
        throw new StemalignError(
            'missing-setting',
            `setting "${source.label}" of model "${source.modelId}" declares no alignment head, the whisper alignment profile cannot work without them`,
            {
                modelId: source.modelId,
                expected: 'at least one alignment head',
                actual: 'none',
            },
        );
    }
    return entries;
}

function matchValues(
    modelId: string,
    label: string,
    actual: number,
    other: string,
    expected: number,
): void {
    if (actual !== expected) {
        throw new StemalignError(
            'setting-mismatch',
            `setting "${label}" of model "${modelId}" says ${actual} but ${other} is ${expected}`,
            {
                modelId,
                expected: `${other} = ${expected}`,
                actual: `${label} = ${actual}`,
            },
        );
    }
}

function describeValue(value: unknown): string {
    if (value === undefined) {
        return 'nothing';
    }
    if (Array.isArray(value)) {
        return `an array of ${value.length}`;
    }
    if (typeof value === 'object' && value !== null) {
        return 'an object';
    }
    return `${typeof value} ${String(value)}`;
}
