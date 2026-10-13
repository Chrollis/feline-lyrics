import { checkPcmAudio, checkSampleRate } from '../audio/check.js';
import type { PcmAudio } from '../audio/types.js';
import { StemalignError } from '../errors.js';

export const MAX_SHIFT_SECONDS = 0.5;

export function buildShiftDelays(
    count: number,
    sampleRate: number,
): readonly number[] {
    if (!Number.isInteger(count) || count < 0) {
        throw new StemalignError(
            'invalid-option',
            `the shift count must be a non-negative integer, got ${count}`,
            {
                expected: 'a non-negative integer',
                actual: String(count),
            },
        );
    }
    if (count === 0) {
        return [0];
    }
    const maxDelay = Math.round(
        MAX_SHIFT_SECONDS * checkSampleRate(sampleRate, 'the target'),
    );
    const delays: number[] = [];
    for (let index = 0; index < count; index += 1) {
        delays.push(Math.round(Math.random() * maxDelay));
    }
    return delays;
}

export function delayAudio(audio: PcmAudio, delay: number): PcmAudio {
    if (!Number.isInteger(delay) || delay < 0) {
        throw new StemalignError(
            'invalid-option',
            `a delay must be a non-negative whole number of frames, got ${delay}`,
            {
                expected: 'a non-negative integer delay',
                actual: String(delay),
            },
        );
    }
    if (delay === 0) {
        return audio;
    }
    const info = checkPcmAudio(audio);
    return {
        sampleRate: audio.sampleRate,
        channels: audio.channels.map((channel) => {
            const delayed = new Float32Array(info.frameCount + delay);
            delayed.set(channel, delay);
            return delayed;
        }),
    };
}
