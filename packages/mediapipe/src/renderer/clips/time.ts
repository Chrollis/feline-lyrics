// Time model, doc section 4: integer milliseconds on the API, seconds and
// microseconds on the wire, integer samples at 48 kHz internally.

/** Sample rate the audio layer works in. */
export const SAMPLE_RATE = 48000;

/** Samples per millisecond at 48 kHz. The only place ms * 48 happens. */
export const SAMPLES_PER_MS = SAMPLE_RATE / 1000; // 48

export function secToMs(sec: number): number {
    return sec * 1000;
}

export function msToSec(ms: number): number {
    return ms / 1000;
}

export function usToMs(us: number): number {
    return us / 1000;
}

export function msToUs(ms: number): number {
    return ms * 1000;
}

export function msToSamples(ms: number): number {
    return ms * SAMPLES_PER_MS;
}

export function samplesToMs(samples: number): number {
    return samples / SAMPLES_PER_MS;
}

/** Clamp an integer millisecond value into [minMs, maxMs]. */
export function clampMs(ms: number, minMs: number, maxMs: number): number {
    return ms < minMs ? minMs : ms > maxMs ? maxMs : ms;
}
