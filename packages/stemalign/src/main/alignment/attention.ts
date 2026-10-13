import { medianFilterRows } from '../audio/median.js';
import { bankersRound } from '../round.js';
import { StemalignError } from '../errors.js';
import { WHISPER_ENCODER_DOWNSAMPLE } from './whisper.js';
import type { DecoderPass } from './decoder.js';
import type { WhisperSettings } from './settings.js';

export interface AttenWeights {
    readonly weights: Float32Array;
    readonly nHeads: number;
    readonly nTokens: number;
    readonly nFrames: number;
    readonly maxQkLen: number;
}

export interface AttentionOptions {
    readonly sotLen: number;
    readonly numSamples: number;
    readonly qkScale?: number;
    readonly medfiltWidth?: number;
}

export function computeAttentionWeights(
    pass: DecoderPass,
    settings: WhisperSettings,
    options: AttentionOptions,
): AttenWeights {
    const { sotLen, numSamples } = options;
    const qkScale = options.qkScale ?? 1;
    const medfiltWidth = options.medfiltWidth ?? settings.medianFilterWidth;
    if (!Number.isInteger(sotLen) || sotLen < 0) {
        throw new StemalignError(
            'invalid-option',
            `prefix token count must be a non-negative integer, got ${sotLen}`,
            { actual: String(sotLen) },
        );
    }
    if (!Number.isInteger(numSamples) || numSamples < 0) {
        throw new StemalignError(
            'invalid-option',
            `sample count must be a non-negative integer, got ${numSamples}`,
            { actual: String(numSamples) },
        );
    }
    if (!Number.isFinite(qkScale)) {
        throw new StemalignError(
            'invalid-option',
            `attention scale must be a finite number, got ${qkScale}`,
            { actual: String(qkScale) },
        );
    }
    if (
        !Number.isInteger(medfiltWidth) ||
        medfiltWidth < 1 ||
        medfiltWidth % 2 === 0
    ) {
        throw new StemalignError(
            'invalid-option',
            `median filter width must be a positive odd integer, got ${medfiltWidth}`,
            { actual: String(medfiltWidth) },
        );
    }
    const nHeads = pass.attentions.length;
    if (nHeads === 0) {
        throw new StemalignError(
            'invalid-option',
            'the decoder pass has no attention heads to align with',
        );
    }
    const nTokens = pass.tokens - sotLen - 1;
    if (nTokens <= 0) {
        throw new StemalignError(
            'invalid-option',
            `the decoder pass has ${pass.tokens} tokens, which leaves no text tokens`,
            { expected: 'at least one text token', actual: String(nTokens) },
        );
    }
    const samplesPerFrame = settings.hopLength * WHISPER_ENCODER_DOWNSAMPLE;
    const maxQkLen = bankersRound(numSamples / samplesPerFrame, 0);
    const nFrames = Math.min(maxQkLen, pass.frames);
    if (nFrames <= 0) {
        throw new StemalignError(
            'invalid-option',
            `the chunk of ${numSamples} samples is shorter than one frame`,
            {
                expected: `at least ${samplesPerFrame} samples`,
                actual: String(numSamples),
            },
        );
    }
    const stack = new Float32Array(nHeads * nTokens * nFrames);
    for (let index = 0; index < nHeads; index += 1) {
        const attention = pass.attentions[index];
        if (
            attention.tokens !== pass.tokens ||
            attention.frames !== pass.frames
        ) {
            throw new StemalignError(
                'model-invalid',
                `attention head ${index} does not match the decoder pass`,
                {
                    expected: `${pass.tokens} tokens and ${pass.frames} frames`,
                    actual: `${attention.tokens} tokens and ${attention.frames} frames`,
                },
            );
        }
        const { values } = attention;
        for (let token = 0; token < nTokens; token += 1) {
            const source = (sotLen + token) * attention.frames;
            const target = (index * nTokens + token) * nFrames;
            for (let frame = 0; frame < nFrames; frame += 1) {
                stack[target + frame] = values[source + frame];
            }
        }
    }
    if (qkScale !== 1) {
        for (let index = 0; index < stack.length; index += 1) {
            stack[index] *= qkScale;
        }
    }
    softmaxLastAxis(stack, nHeads, nTokens, nFrames);
    zScoreOverTokenAxis(stack, nHeads, nTokens, nFrames);
    const weights =
        medfiltWidth > 1
            ? medianFilterRows(stack, nFrames, medfiltWidth)
            : stack;
    return { weights, nHeads, nTokens, nFrames, maxQkLen };
}

function softmaxLastAxis(
    data: Float32Array,
    nHeads: number,
    nTokens: number,
    nFrames: number,
): void {
    for (let head = 0; head < nHeads; head += 1) {
        for (let token = 0; token < nTokens; token += 1) {
            const base = (head * nTokens + token) * nFrames;
            let maximum = -Infinity;
            for (let frame = 0; frame < nFrames; frame += 1) {
                const value = data[base + frame];
                if (value > maximum) {
                    maximum = value;
                }
            }
            let sum = 0;
            for (let frame = 0; frame < nFrames; frame += 1) {
                const exponent = Math.exp(data[base + frame] - maximum);
                data[base + frame] = exponent;
                sum += exponent;
            }
            const inverse = 1 / sum;
            for (let frame = 0; frame < nFrames; frame += 1) {
                data[base + frame] *= inverse;
            }
        }
    }
}

function zScoreOverTokenAxis(
    data: Float32Array,
    nHeads: number,
    nTokens: number,
    nFrames: number,
): void {
    for (let head = 0; head < nHeads; head += 1) {
        const headBase = head * nTokens * nFrames;
        for (let frame = 0; frame < nFrames; frame += 1) {
            let sum = 0;
            for (let token = 0; token < nTokens; token += 1) {
                sum += data[headBase + token * nFrames + frame];
            }
            const mean = sum / nTokens;
            let squares = 0;
            for (let token = 0; token < nTokens; token += 1) {
                const difference =
                    data[headBase + token * nFrames + frame] - mean;
                squares += difference * difference;
            }
            const standardDeviation = Math.sqrt(squares / nTokens);
            if (standardDeviation === 0) {
                for (let token = 0; token < nTokens; token += 1) {
                    data[headBase + token * nFrames + frame] = 0;
                }
                continue;
            }
            const inverse = 1 / standardDeviation;
            for (let token = 0; token < nTokens; token += 1) {
                const index = headBase + token * nFrames + frame;
                data[index] = (data[index] - mean) * inverse;
            }
        }
    }
}
