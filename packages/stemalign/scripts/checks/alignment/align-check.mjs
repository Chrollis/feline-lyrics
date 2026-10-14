import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { openModel } from '../../../out/main/index.js';
import { align } from '../../../out/main/alignment/align.js';
import { inspectWhisper } from '../../../out/main/alignment/whisper.js';
import { inspectWhisperSettings } from '../../../out/main/alignment/settings.js';

const flatWords = (result) =>
    result.segments.flatMap((segment) => segment.words);

const directory = new URL(
    '../../../../../models/Xenova/whisper-base/',
    import.meta.url,
);
const text = (name) => readFileSync(new URL(name, directory), 'utf8');
const bytes = (name) => readFileSync(new URL(name, directory));

const handle = await openModel({
    id: 'whisper-base',
    sessions: {
        encoder: { bytes: bytes('onnx/encoder_model.onnx') },
        decoder: { bytes: bytes('onnx/decoder_model_merged.onnx') },
    },
    settings: {
        config: text('config.json'),
        generation: text('generation_config.json'),
        preprocessor: text('preprocessor_config.json'),
        tokenizer: text('tokenizer.json'),
    },
    executionProviders: ['cpu'],
});

/** Two seconds of tone, one second of silence, repeated (deterministic). */
function speechLike(sampleRate, seconds) {
    const total = Math.trunc(sampleRate * seconds);
    const burst = Math.trunc(sampleRate * 2);
    const gap = Math.trunc(sampleRate);
    const samples = new Float32Array(total);
    for (let index = 0; index < total; index += 1) {
        const phase = index % (burst + gap);
        if (phase >= burst) continue;
        const envelope = Math.sin((Math.PI * phase) / burst);
        const secondsIn = index / sampleRate;
        samples[index] =
            0.4 *
            envelope *
            (Math.sin(2 * Math.PI * 180 * secondsIn) +
                0.5 * Math.sin(2 * Math.PI * 2400 * secondsIn));
    }
    return { sampleRate, channels: [samples] };
}

function decideText(size, pick) {
    return Array.from({ length: size }, (_, index) => pick(index)).join(' ');
}

function checkWords(whole, words) {
    for (const word of words) {
        assert.ok(Number.isFinite(word.start), 'start must be finite');
        assert.ok(Number.isFinite(word.end), 'end must be finite');
        assert.ok(word.start >= 0, 'start must not be negative');
        assert.ok(
            word.start <= word.end,
            `"${word.word}" starts after it ends`,
        );
        assert.ok(
            whole.includes(word.word),
            `"${word.word}" is not in the text`,
        );
        assert.ok(word.tokens.length > 0, 'a word needs at least one token');
    }
    for (let index = 1; index < words.length; index += 1) {
        assert.ok(
            words[index].start >= words[index - 1].start - 1e-9,
            'word starts must never go backwards',
        );
    }
}

function collector() {
    const events = [];
    const onProgress = (event) => events.push(event);
    return { events, onProgress };
}

try {
    const layout = inspectWhisper(handle);
    const settings = inspectWhisperSettings(handle, layout);
    const audio = speechLike(settings.sampleRate, 65);
    const words = decideText(30, (index) =>
        index % 3 === 0 ? 'hello' : 'world',
    );
    const longText = decideText(400, (index) =>
        index % 2 === 0 ? 'hello' : 'world',
    );

    await assert.rejects(
        align(audio, 'hello world', handle, { signal: AbortSignal.abort() }),
        (error) => error.code === 'cancelled',
    );

    const first = collector();
    const result = await align(audio, words, handle, {
        onProgress: first.onProgress,
        failureThreshold: 0,
    });
    // `text` is the concatenation of the surviving segments: stable_ts drops the
    // words that never got a timestamp, so it can be shorter than the input text.
    assert.equal(
        result.text,
        flatWords(result)
            .map((word) => word.word)
            .join(''),
    );
    assert.equal(result.language, 'en');
    assert.ok(result.segments.length >= 1, 'a run must produce a segment');
    assert.ok(
        typeof result.regroup_history === 'string',
        'regroup must report its history',
    );
    assert.ok(flatWords(result).length >= 1, 'some words must align');
    assert.ok(flatWords(result).length <= 30, 'no word may be invented');
    checkWords(words, flatWords(result));
    const last = first.events[first.events.length - 1];
    assert.ok(last !== undefined, 'alignment must report progress');
    // aligner.mjs:1010 -- the flag means "the failure guard never tripped",
    // not "the loop reached the end of the audio".
    assert.equal(typeof last.finished, 'boolean');
    for (let index = 0; index < first.events.length - 1; index += 1) {
        assert.equal(first.events[index].finished, false);
    }
    assert.equal(last.totalSeconds, 65);
    for (const event of first.events) {
        assert.ok(Number.isFinite(event.seconds), 'seconds must be finite');
        assert.ok(event.seconds >= 0, 'seconds must not be negative');
        assert.ok(event.seconds <= event.totalSeconds + 0.001);
    }
    console.log(
        'a 65 second signal aligned',
        flatWords(result).length,
        'of 30 words in',
        first.events.length,
        'window(s)',
    );

    const small = collector();
    const clean = await align(
        speechLike(settings.sampleRate, 1),
        'hello',
        handle,
        { onProgress: small.onProgress, failureThreshold: 0 },
    );
    const cleanLast = small.events[small.events.length - 1];
    assert.ok(
        flatWords(clean).length >= 1,
        'the single word must align',
    );
    assert.equal(cleanLast?.finished, true, 'a clean run reports finished');
    console.log('a clean run reports finished', cleanLast?.finished);

    const short = speechLike(settings.sampleRate, 5);
    const unguarded = collector();
    await align(short, words, handle, { onProgress: unguarded.onProgress });
    assert.equal(
        unguarded.events[unguarded.events.length - 1].finished,
        true,
        'without a failure threshold the guard never trips',
    );
    console.log('without a failure threshold the last event is finished');

    const dropped = await align(short, longText, handle, {
        failureThreshold: 0,
    });
    assert.equal(
        dropped.text,
        flatWords(dropped)
            .map((word) => word.word)
            .join(''),
    );
    assert.ok(
        flatWords(dropped).length > 0,
        'the first window must align something',
    );
    assert.ok(
        flatWords(dropped).length < 400,
        'words without a timestamp must be dropped',
    );
    checkWords(longText, flatWords(dropped));
    console.log(
        'a five second signal kept',
        flatWords(dropped).length,
        'of 400 words and dropped the rest',
    );

    const events = [];
    const controller = new AbortController();
    await assert.rejects(
        align(audio, longText, handle, {
            signal: controller.signal,
            onProgress: (event) => {
                events.push(event);
                if (events.length === 2) controller.abort();
            },
        }),
        (error) => error.code === 'cancelled',
    );
    assert.ok(events.length >= 2, 'the window loop must keep advancing');
    assert.ok(
        events.every((event) => event.finished === false),
        'an aborted run must not report finished',
    );
    console.log('an aborted run stopped after', events.length, 'window(s)');

    await assert.rejects(
        align(audio, 'hello', handle, { language: 'zz' }),
        (error) => error.code === 'missing-setting',
    );
    await assert.rejects(
        align(audio, 'hello', handle, { maxSegmentLength: 1.5 }),
        (error) => error.code === 'invalid-option',
    );
    await assert.rejects(
        align(audio, 'hello', handle, {
            maxSegmentLength: settings.nSamples + 1,
        }),
        (error) => error.code === 'invalid-option',
    );

    // toChannelCount(..., 1) averages any channel count (channels.ts:10-22);
    // only the stereo path rejects more than two channels. Pure silence never
    // aligns a word, so this pins "three channels are accepted".
    const zero = new Float32Array(settings.sampleRate);
    const mixed = await align(
        {
            sampleRate: settings.sampleRate,
            channels: [zero, zero.slice(), zero.slice()],
        },
        'hello',
        handle,
        {},
    );
    assert.equal(mixed.text, '');
    assert.deepEqual(mixed.segments, []);
    assert.deepEqual(flatWords(mixed), []);
    console.log('a three channel silence downmixes and aligns nothing');
    await assert.rejects(
        align({ sampleRate: 0, channels: [zero] }, 'hello', handle, {}),
        (error) => error.code === 'invalid-pcm',
    );

    console.log('every alignment invariant holds');
} finally {
    await handle.release();
}
