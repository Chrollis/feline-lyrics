import { StemalignError } from '../errors.js';
import type { PcmAudio } from '../audio/types.js';
import { checkPcmAudio } from '../audio/check.js';
import type { WhisperSettings } from './settings.js';
import { createFftPlan, realFft } from './fft.js';
import { buildMelFilters } from './mel-filters.js';

export const MEL_FLOOR = 1e-10;
export const MEL_DYNAMIC_RANGE = 8.0;
export const MEL_OFFSET = 4.0;
export const MEL_SCALE = 4.0;

export interface MelBlock {
    readonly melBins: number;
    readonly frames: number;
    readonly values: Float32Array;
}

function hannWindow(size: number): Float32Array {
    const window = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
        window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / size));
    }
    return window;
}

function reflectInto(
    output: Float32Array,
    signal: Float32Array,
    pad: number,
): void {
    for (let index = 0; index < pad; index += 1) {
        output[index] = signal[pad - index];
    }
    output.set(signal, pad);
    const last = signal.length - 1;
    for (let index = 0; index < pad; index += 1) {
        output[pad + signal.length + index] = signal[last - 1 - index];
    }
}

export function melLogPower(
    audio: PcmAudio,
    settings: WhisperSettings,
): MelBlock {
    const info = checkPcmAudio(audio);
    if (info.sampleRate !== settings.sampleRate) {
        throw new StemalignError(
            'invalid-pcm',
            `mel expects ${settings.sampleRate} Hz audio, got ${info.sampleRate}`,
            {
                expected: `${settings.sampleRate} Hz`,
                actual: `${info.sampleRate} Hz`,
            },
        );
    }
    if (info.channelCount !== 1) {
        throw new StemalignError(
            'unsupported-layout',
            'mel expects mono audio',
            {
                expected: 'mono audio',
                actual: `${info.channelCount} channels`,
            },
        );
    }
    if (info.frameCount > settings.nSamples) {
        throw new StemalignError(
            'invalid-option',
            `mel expects at most ${settings.nSamples} samples, got ${info.frameCount}`,
            {
                expected: `at most ${settings.nSamples} samples`,
                actual: `${info.frameCount} samples`,
            },
        );
    }

    const samples = new Float32Array(settings.nSamples);
    samples.set(audio.channels[0]);
    const pad = Math.floor(settings.nFft / 2);
    const padded = new Float32Array(samples.length + 2 * pad);
    reflectInto(padded, samples, pad);

    const bins = Math.floor(settings.nFft / 2) + 1;
    const frames = settings.nbMaxFrames;
    const plan = createFftPlan(settings.nFft);
    const filters = buildMelFilters(
        settings.sampleRate,
        settings.nFft,
        settings.melBins,
    );
    const window = hannWindow(settings.nFft);
    const frame = new Float32Array(settings.nFft);
    const real = new Float32Array(bins);
    const imag = new Float32Array(bins);
    const values = new Float32Array(settings.melBins * frames);

    for (let index = 0; index < frames; index += 1) {
        const start = index * settings.hopLength;
        for (let tap = 0; tap < settings.nFft; tap += 1) {
            frame[tap] = padded[start + tap] * window[tap];
        }
        realFft(plan, frame, real, imag);
        for (let mel = 0; mel < settings.melBins; mel += 1) {
            const offset = mel * bins;
            let power = 0;
            for (let bin = 0; bin < bins; bin += 1) {
                const weight = filters.values[offset + bin];
                if (weight !== 0) {
                    power +=
                        weight *
                        (real[bin] * real[bin] + imag[bin] * imag[bin]);
                }
            }
            values[mel * frames + index] = Math.log10(
                Math.max(power, MEL_FLOOR),
            );
        }
    }

    return { melBins: settings.melBins, frames, values };
}

export function melMaximum(block: MelBlock): number {
    let maximum = -Infinity;
    for (let index = 0; index < block.values.length; index += 1) {
        if (block.values[index] > maximum) {
            maximum = block.values[index];
        }
    }
    return maximum;
}

export function normalizeMel(block: MelBlock, maximum: number): MelBlock {
    if (!Number.isFinite(maximum)) {
        throw new StemalignError(
            'invalid-option',
            `mel maximum must be a finite number, got ${maximum}`,
            {
                expected: 'a finite number',
                actual: String(maximum),
            },
        );
    }
    const floor = maximum - MEL_DYNAMIC_RANGE;
    const values = new Float32Array(block.values.length);
    for (let index = 0; index < block.values.length; index += 1) {
        values[index] =
            (Math.max(block.values[index], floor) + MEL_OFFSET) / MEL_SCALE;
    }
    return { melBins: block.melBins, frames: block.frames, values };
}

export function melSpectrogram(
    audio: PcmAudio,
    settings: WhisperSettings,
    maximum?: number,
): MelBlock {
    const power = melLogPower(audio, settings);
    return normalizeMel(power, maximum ?? melMaximum(power));
}
