import { StemalignError } from '../errors.js';

const FREQUENCY_STEP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / FREQUENCY_STEP;
const LOG_STEP = Math.log(6.4) / 27;

export interface MelFilters {
    readonly melBins: number;
    readonly bins: number;
    readonly values: Float32Array;
}

function hzToMel(hz: number): number {
    if (hz >= MIN_LOG_HZ) {
        return MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP;
    }
    return hz / FREQUENCY_STEP;
}

function melToHz(mel: number): number {
    if (mel >= MIN_LOG_MEL) {
        return MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL));
    }
    return FREQUENCY_STEP * mel;
}

function checkOption(label: string, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
        throw new StemalignError(
            'invalid-option',
            `${label} must be a positive integer, got ${value}`,
            {
                expected: 'a positive integer',
                actual: String(value),
            },
        );
    }
}

export function buildMelFilters(
    sampleRate: number,
    nFft: number,
    melBins: number,
): MelFilters {
    checkOption('sample rate', sampleRate);
    checkOption('fft size', nFft);
    checkOption('mel bins', melBins);
    if (nFft < 2) {
        throw new StemalignError(
            'invalid-option',
            `fft size must be at least 2, got ${nFft}`,
            {
                expected: 'at least 2',
                actual: String(nFft),
            },
        );
    }

    const bins = Math.floor(nFft / 2) + 1;
    const minimumMel = hzToMel(0);
    const maximumMel = hzToMel(sampleRate / 2);

    // The n_mels + 2 edges are evenly spaced in mel, so the step divides by n_mels + 1.
    const edges = new Float64Array(melBins + 2);
    for (let index = 0; index < melBins + 2; index += 1) {
        edges[index] = melToHz(
            minimumMel + ((maximumMel - minimumMel) * index) / (melBins + 1),
        );
    }

    const frequencies = new Float64Array(bins);
    for (let bin = 0; bin < bins; bin += 1) {
        frequencies[bin] = (bin * sampleRate) / nFft;
    }

    const values = new Float32Array(melBins * bins);
    for (let mel = 0; mel < melBins; mel += 1) {
        const lower = edges[mel];
        const center = edges[mel + 1];
        const upper = edges[mel + 2];
        const normalizer = 2 / (upper - lower);
        for (let bin = 0; bin < bins; bin += 1) {
            const rising = (frequencies[bin] - lower) / (center - lower);
            const falling = (upper - frequencies[bin]) / (upper - center);
            values[mel * bins + bin] =
                Math.max(0, Math.min(rising, falling)) * normalizer;
        }
    }

    return { melBins, bins, values };
}
