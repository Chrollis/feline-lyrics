import { StemalignError } from '../errors.js';
import type { PcmAudio } from './types.js';

export interface PcmAudioInfo {
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly frameCount: number;
}

export function checkPcmAudio(audio: PcmAudio): PcmAudioInfo {
    const { sampleRate, channels } = audio;

    checkSampleRate(sampleRate, 'input');

    const first = channels[0];
    if (first === undefined) {
        throw new StemalignError(
            'invalid-pcm',
            'audio must have at least one channel',
            {
                expected: 'at least one channel',
                actual: '0 channels',
            },
        );
    }
    const frameCount = first.length;
    for (const [index, channel] of channels.entries()) {
        if (channel.length !== frameCount) {
            throw new StemalignError(
                'invalid-pcm',
                `channel 0 has ${frameCount} samples but channel ${index} has ${channel.length}`,
                {
                    expected:
                        'every channel to have the same number of samples',
                    actual: `channel 0: ${frameCount}, channel ${index}: ${channel.length}`,
                },
            );
        }
    }
    return { sampleRate, channelCount: channels.length, frameCount };
}

export function checkSampleRate(value: number, label: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new StemalignError(
            'invalid-pcm',
            `${label} sample rate must be a positive integer, got ${value}`,
            {
                expected: 'a positive integer sample rate in Hz',
                actual: String(value),
            },
        );
    }
    return value;
}
