import { checkPcmAudio, checkSampleRate } from './check.js';
import type { PcmAudio } from './types.js';

const ZERO_CROSSINGS = 16; // taps per side; 16 ~= high fidelity
const BETA = 8.6; // Kaiser beta, ~-90dB stopband
const I0_BETA = besselI0(BETA);

function besselI0(x: number): number {
    let sum = 1;
    let term = 1;
    const half = x * 0.5;
    for (let k = 1; k < 64; k += 1) {
        const f = half / k;
        term *= f * f;
        sum += term;
        if (term < sum * 1e-16) break;
    }
    return sum;
}

function sinc(x: number): number {
    if (x === 0) return 1;
    const px = Math.PI * x;
    return Math.sin(px) / px;
}

function greatestCommonDivisor(a: number, b: number): number {
    let left = a;
    let right = b;
    while (right !== 0) {
        const remainder = left % right;
        left = right;
        right = remainder;
    }
    return left;
}

interface PolyphaseFilter {
    readonly weights: Float64Array;
    readonly phases: number;
    readonly srcStep: number;
    readonly taps: number;
    readonly halfTaps: number;
}

// The kernel only depends on where an output sample lands inside a source
// sample, and that fraction repeats every targetRate / gcd(source, target)
// outputs, so a table of the distinct rows replaces the per tap math.
function buildFilter(
    srcRate: number,
    targetRate: number,
    halfWidth: number,
): PolyphaseFilter {
    const divisor = greatestCommonDivisor(srcRate, targetRate);
    const srcStep = srcRate / divisor;
    const phases = targetRate / divisor;
    const halfTaps = Math.ceil(halfWidth);
    const taps = halfTaps * 2;
    const cutoff = Math.min(1, targetRate / srcRate);
    const weights = new Float64Array(phases * taps);

    for (let phase = 0; phase < phases; phase += 1) {
        const fraction = phase / phases;
        const row = phase * taps;
        let sum = 0;

        for (let tap = 0; tap < taps; tap += 1) {
            const offset = fraction + halfTaps - 1 - tap;
            const t = offset / halfWidth;
            if (t <= -1 || t >= 1) continue;

            // Kaiser window over t in [-1, 1]
            const window = besselI0(BETA * Math.sqrt(1 - t * t)) / I0_BETA;
            // Bandlimited sinc; cutoff < 1 handles downsampling
            const weight = sinc(offset * cutoff) * window;

            weights[row + tap] = weight;
            sum += weight;
        }

        // Normalizing the row keeps the per sample divide out of the loop.
        if (sum !== 0) {
            for (let tap = 0; tap < taps; tap += 1) {
                weights[row + tap] /= sum;
            }
        }
    }

    return { weights, phases, srcStep, taps, halfTaps };
}

export function resample(audio: PcmAudio, targetSampleRate: number): PcmAudio {
    const info = checkPcmAudio(audio);
    checkSampleRate(targetSampleRate, 'target');

    const srcRate = info.sampleRate;
    const frameCount = info.frameCount;

    if (targetSampleRate === srcRate) return audio;
    if (frameCount === 0) {
        return {
            sampleRate: targetSampleRate,
            channels: audio.channels.map(() => new Float32Array(0)),
        };
    }

    const ratio = srcRate / targetSampleRate; // source frames per output frame
    const outputFrames = Math.max(1, Math.round(frameCount / ratio));

    // Antialiasing: clamp cutoff to source and target Nyquist
    const cutoff = Math.min(1, targetSampleRate / srcRate);
    const halfWidth = ZERO_CROSSINGS / cutoff; // kernel half-width in source samples

    const { weights, phases, srcStep, taps, halfTaps } = buildFilter(
        srcRate,
        targetSampleRate,
        halfWidth,
    );
    const lastIndex = frameCount - 1;

    const channels = audio.channels.map((channel) => {
        const output = new Float32Array(outputFrames);

        for (let i = 0; i < outputFrames; i += 1) {
            const base = Math.floor(i * ratio); // whole source position
            const row = ((i * srcStep) % phases) * taps;
            const start = base - halfTaps + 1;
            let acc = 0;

            if (start >= 0 && start + taps <= frameCount) {
                let index = start;
                for (let tap = 0; tap < taps; tap += 1) {
                    acc += channel[index] * weights[row + tap];
                    index += 1;
                }
            } else {
                // Clamp to edges; equivalent to constant extrapolation
                for (let tap = 0; tap < taps; tap += 1) {
                    const j = start + tap;
                    const index = j < 0 ? 0 : j > lastIndex ? lastIndex : j;
                    acc += channel[index] * weights[row + tap];
                }
            }

            output[i] = acc;
        }
        return output;
    });

    return { sampleRate: targetSampleRate, channels };
}
