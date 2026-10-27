import assert from 'node:assert/strict';
import {
    buildShiftDelays,
    delayAudio,
} from '../../src/main/separation/sep-shifts.js';
import { describe, it } from 'node:test';

describe('shifts', () => {
    it('builds delays and pads the audio', async () => {
        assert.deepEqual(buildShiftDelays(0, 44100), [0]);
        const random = buildShiftDelays(8, 44100);
        assert.equal(random.length, 8);
        for (const delay of random) {
            assert.ok(Number.isInteger(delay));
            assert.ok(delay >= 0 && delay <= 22050);
        }
        assert.throws(
            () => buildShiftDelays(-1, 44100),
            (error) => error.code === 'invalid-option',
        );
        assert.throws(
            () => buildShiftDelays(2, 7.5),
            (error) => error.code === 'invalid-pcm',
        );

        const audio = {
            sampleRate: 44100,
            channels: [
                Float32Array.from([1, 2, 3]),
                Float32Array.from([4, 5, 6]),
            ],
        };
        assert.equal(delayAudio(audio, 0), audio);
        const delayed = delayAudio(audio, 2);
        assert.equal(delayed.sampleRate, 44100);
        assert.equal(delayed.channels.length, 2);
        assert.deepEqual(Array.from(delayed.channels[0]), [0, 0, 1, 2, 3]);
        assert.deepEqual(Array.from(delayed.channels[1]), [0, 0, 4, 5, 6]);
        assert.deepEqual(Array.from(audio.channels[0]), [1, 2, 3]);
        assert.throws(
            () => delayAudio(audio, -1),
            (error) => error.code === 'invalid-option',
        );
        assert.throws(
            () => delayAudio(audio, 1.5),
            (error) => error.code === 'invalid-option',
        );
        console.log('shift delays and delayed audio behave');
    });
});
