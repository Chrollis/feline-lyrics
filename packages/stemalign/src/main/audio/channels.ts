import { StemalignError } from '../errors.js';
import { checkPcmAudio } from './check.js';
import type { PcmAudio } from './types.js';

export function toChannelCount(audio: PcmAudio, count: 1 | 2): PcmAudio {
    const info = checkPcmAudio(audio);
    if (info.channelCount === count) {
        return audio;
    }
    if (count === 1) {
        const mono = new Float32Array(info.frameCount);
        for (const channel of audio.channels) {
            for (let index = 0; index < info.frameCount; index += 1) {
                mono[index] += channel[index];
            }
        }
        const gain = 1 / info.channelCount;
        for (let index = 0; index < info.frameCount; index += 1) {
            mono[index] *= gain;
        }
        return { sampleRate: info.sampleRate, channels: [mono] };
    }
    if (info.channelCount > 2) {
        throw new StemalignError(
            'unsupported-layout',
            `cannot convert ${info.channelCount} channels to ${count}`,
            {
                expected: 'mono or stereo audio',
                actual: `${info.channelCount} channels`,
            },
        );
    }
    const source = audio.channels[0];
    return {
        sampleRate: info.sampleRate,
        channels: [source, source.slice()],
    };
}
