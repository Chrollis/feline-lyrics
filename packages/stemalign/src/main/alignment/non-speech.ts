import { checkPcmAudio } from '../audio/check.js';
import type { PcmAudio } from '../audio/types.js';
import { StemalignError } from '../errors.js';
import { bankersRound } from '../round.js';

export interface SilenceSpan {
    readonly start: number;
    readonly end: number;
}

export interface SilenceMaskOptions {
    readonly unitSamples?: number;
    readonly qLevels?: number;
    readonly kSize?: number;
}

export const SILENCE_UNIT_SAMPLES = 320;
const Q_LEVELS = 20;
const K_SIZE = 5;
const MIN_VOICE_DUR = 0.1;

// Silence mask over loudness units: 1 means silent. A fully silent segment comes
// back as an all-ones mask; a segment with no silence at all comes back as null.
export function silenceMask(
    audio: PcmAudio,
    options: SilenceMaskOptions = {},
): Uint8Array | null {
    const info = checkPcmAudio(audio);
    if (info.channelCount !== 1) {
        throw new StemalignError(
            'unsupported-layout',
            `the non-speech detector needs mono audio, got ${info.channelCount} channels`,
            { expected: 'mono audio', actual: `${info.channelCount} channels` },
        );
    }

    const unitSamples = positiveInteger(
        options.unitSamples ?? SILENCE_UNIT_SAMPLES,
        'unit length',
    );
    const qLevels = nonNegativeInteger(
        options.qLevels ?? Q_LEVELS,
        'quantization levels',
    );
    const kSize = oddPositiveInteger(
        options.kSize ?? K_SIZE,
        'smoothing kernel',
    );

    const loudness = audio2Loudness(audio.channels[0], unitSamples);
    if (loudness === null) return null;

    const length = loudness.length;
    const half = kSize >> 1;
    const levels =
        half > 0 && half < length
            ? avgPool1dReflect(loudness, kSize)
            : Float32Array.from(loudness);

    if (qLevels !== 0) {
        for (let index = 0; index < length; index += 1) {
            levels[index] = bankersRound(levels[index] * qLevels, 0);
        }
    }

    const voice = new Uint8Array(length);
    let anyVoice = false;
    for (let index = 0; index < length; index += 1) {
        if (levels[index] !== 0) {
            voice[index] = 1;
            anyVoice = true;
        }
    }
    if (!anyVoice) return allSilent(length);

    // Voice runs shorter than MIN_VOICE_DUR are treated as silence.
    const secondsPerUnit = unitSamples / info.sampleRate;
    const kept = runs(voice).filter(
        (run) => (run.end - run.start) * secondsPerUnit > MIN_VOICE_DUR,
    );
    if (kept.length === 0) return allSilent(length);

    // The reference maps the kept runs back through a closed interval mask
    // builder ([mi, me] inclusive) while its mask to timing helper reports
    // half-open ends (the index after the last voiced unit). Each kept run
    // therefore swallows one unit past its last voiced unit, which can erase a
    // one unit gap entirely: 0 1 1 1 0 0 1 1 1 0 becomes 0 1 1 1 1 0 1 1 1 1,
    // and a real 0.02 s gap then leaves no silence at all, so silenceMask
    // returns null ("nothing to suppress"). Kept deliberately: it agrees with
    // the reference unit for unit on six probe signals. Dropping the inclusive
    // end here is the one-character fix, to be verified with the same probe.
    const voiceKept = new Uint8Array(length);
    for (const run of kept) {
        const last = Math.min(run.end, length - 1);
        for (let index = run.start; index <= last; index += 1)
            voiceKept[index] = 1;
    }

    const silence = new Uint8Array(length);
    let anySilence = false;
    for (let index = 0; index < length; index += 1) {
        if (voiceKept[index] === 0) {
            silence[index] = 1;
            anySilence = true;
        }
    }

    return anySilence ? silence : null;
}

export function maskSpans(
    mask: Uint8Array | null,
    secondsPerUnit: number,
    offset = 0,
): readonly SilenceSpan[] {
    if (mask === null || mask.length === 0) return [];
    if (!Number.isFinite(secondsPerUnit) || secondsPerUnit <= 0) {
        throw new StemalignError(
            'invalid-option',
            `the unit duration must be a positive number, got ${secondsPerUnit}`,
            { expected: 'a positive duration', actual: String(secondsPerUnit) },
        );
    }
    if (!Number.isFinite(offset)) {
        throw new StemalignError(
            'invalid-option',
            `the time offset must be a finite number, got ${offset}`,
            { expected: 'a finite time offset', actual: String(offset) },
        );
    }

    return runs(mask).map((run) => ({
        start: run.start * secondsPerUnit + offset,
        end: run.end * secondsPerUnit + offset,
    }));
}

export function filterSilences(
    spans: readonly SilenceSpan[],
    minSilenceDur: number,
): readonly SilenceSpan[] {
    if (!Number.isFinite(minSilenceDur) || minSilenceDur < 0) {
        throw new StemalignError(
            'invalid-option',
            `the minimum silence duration must be a non-negative number, got ${minSilenceDur}`,
            {
                expected: 'a non-negative duration',
                actual: String(minSilenceDur),
            },
        );
    }

    return spans.filter((span) => span.end - span.start >= minSilenceDur);
}

export function mergeSilences(
    spans: readonly SilenceSpan[],
): readonly SilenceSpan[] {
    if (spans.length === 0) return [];

    let starts = spans.map((span) => span.start).sort((a, b) => a - b);
    let ends = spans.map((span) => span.end).sort((a, b) => a - b);

    while (starts.length > 1) {
        let separated = true;
        for (let index = 0; index < starts.length - 1; index += 1) {
            if (starts[index + 1] < ends[index]) {
                separated = false;
                break;
            }
        }
        if (separated) break;

        const keepStart = new Uint8Array(starts.length);
        const keepEnd = new Uint8Array(ends.length);
        keepStart[0] = 1;
        keepEnd[ends.length - 1] = 1;
        for (let index = 0; index < starts.length - 1; index += 1) {
            if (starts[index + 1] >= ends[index]) {
                keepStart[index + 1] = 1;
                keepEnd[index] = 1;
            }
        }
        starts = starts.filter((_value, index) => keepStart[index] !== 0);
        ends = ends.filter((_value, index) => keepEnd[index] !== 0);
    }

    return starts.map((start, index) => ({ start, end: ends[index] }));
}

// Voice units below this count mean the whole segment counts as silent.
export function nonSilentUnits(mask: Uint8Array): number {
    let silent = 0;
    for (let index = 0; index < mask.length; index += 1) {
        if (mask[index] !== 0) silent += 1;
    }
    return mask.length - silent;
}

interface Run {
    readonly start: number;
    readonly end: number;
}

function runs(mask: Uint8Array): readonly Run[] {
    const found: Run[] = [];
    const length = mask.length;
    let index = 0;
    while (index < length) {
        if (mask[index] === 0) {
            index += 1;
            continue;
        }
        const start = index;
        while (index < length && mask[index] !== 0) index += 1;
        found.push({ start, end: index });
    }
    return found;
}

function allSilent(length: number): Uint8Array {
    const mask = new Uint8Array(length);
    mask.fill(1);
    return mask;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new StemalignError(
            'invalid-option',
            `the ${label} must be a positive integer, got ${value}`,
            { expected: `a positive ${label}`, actual: String(value) },
        );
    }
    return value;
}

function nonNegativeInteger(value: number, label: string): number {
    if (!Number.isInteger(value) || value < 0) {
        throw new StemalignError(
            'invalid-option',
            `the ${label} must be a non-negative integer, got ${value}`,
            { expected: `a non-negative ${label}`, actual: String(value) },
        );
    }
    return value;
}

function oddPositiveInteger(value: number, label: string): number {
    const checked = positiveInteger(value, label);
    if ((checked & 1) === 0) {
        throw new StemalignError(
            'invalid-option',
            `the ${label} must be odd, got ${value}`,
            { expected: `an odd ${label}`, actual: String(value) },
        );
    }
    return checked;
}

// abs -> normalize by a robust peak -> linear interpolation to unit resolution.
function audio2Loudness(
    samples: Float32Array,
    unitSamples: number,
): Float32Array | null {
    const length = samples.length;
    if (length === 0) return null;

    const magnitudes = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
        const value = samples[index];
        magnitudes[index] = value < 0 ? -value : value;
    }

    const k = Math.trunc(length * 0.001);
    const threshold =
        k > 0 ? nthLargest(magnitudes, k) : quantile(magnitudes, 0.999);

    const unitCount = bankersRound(length / unitSamples, 0) + 1;
    if (unitCount <= 2) return null;

    if (threshold < 1e-5) return new Float32Array(unitCount);

    const scale = 1 / Math.min(1, threshold * 1.75);
    const scaled = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
        scaled[index] = magnitudes[index] * scale;
    }

    return linearInterpolate(scaled, unitCount);
}

// PyTorch F.interpolate(mode='linear', align_corners=False) for one dimension.
function linearInterpolate(
    source: Float32Array,
    outLength: number,
): Float32Array {
    const inLength = source.length;
    const output = new Float32Array(outLength);
    if (inLength === 0 || outLength === 0) return output;
    if (inLength === 1) {
        output.fill(source[0]);
        return output;
    }

    const scale = inLength / outLength;
    for (let index = 0; index < outLength; index += 1) {
        let position = (index + 0.5) * scale - 0.5;
        if (position < 0) position = 0;
        else if (position > inLength - 1) position = inLength - 1;
        const lower = Math.floor(position);
        const upper = lower + 1 < inLength ? lower + 1 : inLength - 1;
        const weight = position - lower;
        output[index] = (1 - weight) * source[lower] + weight * source[upper];
    }
    return output;
}

// torch.avg_pool1d(F.pad(x, (p, p), 'reflect'), kernel_size=k, stride=1).
function avgPool1dReflect(values: Float32Array, kSize: number): Float32Array {
    const length = values.length;
    const half = kSize >> 1;
    const output = new Float32Array(length);
    const inverse = 1 / kSize;

    for (let index = 0; index < length; index += 1) {
        let sum = 0;
        for (let offset = -half; offset <= half; offset += 1) {
            let source = index + offset;
            if (source < 0) source = -source;
            else if (source >= length) source = 2 * length - 2 - source;
            sum += values[source];
        }
        output[index] = sum * inverse;
    }
    return output;
}

function nthLargest(values: Float32Array, k: number): number {
    if (k <= 0 || k > values.length) {
        throw new StemalignError(
            'invalid-option',
            `the rank must be within 1..${values.length}, got ${k}`,
            { expected: 'a valid rank', actual: String(k) },
        );
    }
    const work = Float32Array.from(values);
    return quickselect(work, 0, work.length - 1, work.length - k);
}

function quickselect(
    values: Float32Array,
    low: number,
    high: number,
    target: number,
): number {
    let lo = low;
    let hi = high;
    while (lo < hi) {
        const pivot = values[hi];
        let store = lo;
        for (let index = lo; index < hi; index += 1) {
            if (values[index] < pivot) {
                const swap = values[store];
                values[store] = values[index];
                values[index] = swap;
                store += 1;
            }
        }
        const swap = values[store];
        values[store] = values[hi];
        values[hi] = swap;
        if (store === target) return values[store];
        if (store < target) lo = store + 1;
        else hi = store - 1;
    }
    return values[lo];
}

function quantile(values: Float32Array, fraction: number): number {
    const sorted = Float32Array.from(values);
    sorted.sort();
    const length = sorted.length;
    if (length === 0) return NaN;
    const position = (length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, length - 1);
    const weight = position - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
