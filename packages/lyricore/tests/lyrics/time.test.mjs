import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    endOf,
    isTime,
    isValidSpan,
    joinTime,
    splitTime,
    TIME_MAX,
    TIME_MIN,
} from '../../src/main/lyrics/time.js';

describe('time', () => {
    it('splits a time into the units a level keeps', () => {
        assert.deepEqual(splitTime(90_000, 1), {
            d: 0,
            h: 0,
            m: 0,
            s: 0,
            ms: 90_000,
        });
        assert.deepEqual(splitTime(90_000, 2), {
            d: 0,
            h: 0,
            m: 0,
            s: 90,
            ms: 0,
        });
        assert.deepEqual(splitTime(90_000, 3), {
            d: 0,
            h: 0,
            m: 1,
            s: 30,
            ms: 0,
        });
        assert.deepEqual(splitTime(90_000, 5), {
            d: 0,
            h: 0,
            m: 1,
            s: 30,
            ms: 0,
        });
        console.log('a level keeps its own unit and every smaller one');
    });

    it('keeps only the largest kept unit negative', () => {
        assert.deepEqual(splitTime(-30_000, 3), {
            d: 0,
            h: 0,
            m: -1,
            s: 30,
            ms: 0,
        });
        assert.deepEqual(splitTime(-1, 3), {
            d: 0,
            h: 0,
            m: -1,
            s: 59,
            ms: 999,
        });
        assert.deepEqual(splitTime(-90_000, 2), {
            d: 0,
            h: 0,
            m: 0,
            s: -90,
            ms: 0,
        });
        console.log('only the largest kept unit carries the sign');
    });

    it('covers the whole int32 range', () => {
        assert.deepEqual(splitTime(TIME_MAX, 5), {
            d: 24,
            h: 20,
            m: 31,
            s: 23,
            ms: 647,
        });
        assert.deepEqual(splitTime(TIME_MIN, 5), {
            d: -25,
            h: 3,
            m: 28,
            s: 36,
            ms: 352,
        });
        console.log('both ends of the int32 millisecond range split exactly');
    });

    it('round trips through every level', () => {
        const samples = [
            0,
            1,
            -1,
            999,
            -999,
            1_000,
            -1_000,
            86_400_000,
            -86_400_000,
            5_000_000,
            -7_777_777,
            TIME_MAX,
            TIME_MIN,
        ];
        for (const ms of samples) {
            for (let level = 1; level <= 5; level += 1) {
                assert.equal(joinTime(splitTime(ms, level)), ms);
            }
        }
        console.log(
            'joinTime(splitTime(ms, level)) is the identity at every level',
        );
    });

    it('joins a signed sum, treating a missing unit as zero', () => {
        assert.equal(joinTime({}), 0);
        assert.equal(joinTime({ m: -1, s: -30 }), -90_000);
        assert.equal(joinTime({ s: 1, ms: 500 }), 1_500);
        assert.equal(joinTime({ ms: 2.5 }), 3);
        assert.equal(joinTime({ ms: -2.5 }), -2);
        assert.equal(Object.is(joinTime({ ms: 0.4 }), 0), true);
        console.log(
            'joinTime sums signed parts, rounds once and never yields -0',
        );
    });

    it('rejects a time or a level outside the model', () => {
        assert.equal(isTime(0), true);
        assert.equal(isTime(TIME_MIN), true);
        assert.equal(isTime(TIME_MAX), true);
        assert.equal(isTime(TIME_MAX + 1), false);
        assert.equal(isTime(0.5), false);

        assert.equal(isValidSpan({ start: 0, duration: 0 }), true);
        assert.equal(isValidSpan({ start: -1_000, duration: 2_000 }), true);
        assert.equal(isValidSpan({ start: 0, duration: -1 }), false);
        assert.equal(isValidSpan({ start: 0.5, duration: 1 }), false);

        assert.throws(
            () => splitTime(1, 0),
            (error) => error.code === 'invalid-time-level',
        );
        assert.throws(
            () => splitTime(1, 6),
            (error) => error.code === 'invalid-time-level',
        );
        assert.throws(
            () => splitTime(TIME_MAX + 1, 1),
            (error) => error.code === 'invalid-time',
        );
        assert.throws(
            () => joinTime({ d: 1e9 }),
            (error) => error.code === 'invalid-time',
        );
        console.log(
            'invalid times and levels are rejected with their own codes',
        );
    });

    it('refuses a span whose end leaves the int32 range', () => {
        assert.equal(endOf({ start: 1_000, duration: 2_000 }), 3_000);
        assert.throws(
            () => endOf({ start: TIME_MAX, duration: 1 }),
            (error) => error.code === 'invalid-time-span',
        );
        assert.throws(
            () => endOf({ start: 0, duration: -1 }),
            (error) => error.code === 'invalid-time-span',
        );
        console.log('endOf validates the span and then the end it produces');
    });
});
