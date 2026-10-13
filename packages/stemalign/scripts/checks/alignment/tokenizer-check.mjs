import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectWhisperSettings } from '../../../out/main/alignment/settings.js';
import { inspectWhisperTokenizer } from '../../../out/main/alignment/tokenizer.js';

const directory = new URL(
    '../../../../../models/Xenova/whisper-base/',
    import.meta.url,
);
const settings = {
    tokenizer: readFileSync(new URL('tokenizer.json', directory), 'utf8'),
    config: readFileSync(new URL('config.json', directory), 'utf8'),
    generation: readFileSync(
        new URL('generation_config.json', directory),
        'utf8',
    ),
    preprocessor: readFileSync(
        new URL('preprocessor_config.json', directory),
        'utf8',
    ),
};

const config = JSON.parse(settings.config);
const handle = { id: 'whisper-base', settings };
const layout = {
    layers: config.decoder_layers,
    heads: config.decoder_attention_heads,
    headDim: config.d_model / config.decoder_attention_heads,
    vocabSize: config.vocab_size,
    melBins: config.num_mel_bins,
};

const inspected = inspectWhisperSettings(handle, layout);
const tokenizer = inspectWhisperTokenizer(handle, inspected);

assert.equal(tokenizer.vocabSize, inspected.vocabSize);
assert.equal(tokenizer.timestampBegin, inspected.noTimestampsTokenId + 1);
assert.equal(tokenizer.timestampBegin, 50364);
assert.equal(tokenizer.timestampEnd, 51864);

assert.equal(tokenizer.tokenText(220), 'Ġ');
assert.equal(tokenizer.tokenText(50257), '<|endoftext|>');
assert.equal(tokenizer.tokenText(50363), '<|notimestamps|>');
assert.equal(tokenizer.tokenText(51864), '<|30.00|>');
assert.equal(tokenizer.isSpecialToken(220), false);
assert.equal(tokenizer.isSpecialToken(50257), true);
assert.equal(tokenizer.isTimestampToken(50363), false);
assert.equal(tokenizer.isTimestampToken(50364), true);
assert.equal(tokenizer.timestampSeconds(50364), 0);
assert.ok(Math.abs(tokenizer.timestampSeconds(51864) - 30) < 1e-9);

assert.equal(tokenizer.decode([]), '');
assert.equal(tokenizer.decode([220]), ' ');
assert.equal(tokenizer.decode([220, 50257]), ' <|endoftext|>');
assert.equal(tokenizer.decode([50364, 220, 50257]), '<|0.00|> <|endoftext|>');
assert.equal(tokenizer.decode([5975]), '中');
assert.equal(tokenizer.decode([17174]), '文');
assert.equal(tokenizer.decode([940, 255]), '中');

let partial = -1;
for (let id = 0; id < tokenizer.vocabSize; id += 1) {
    if (tokenizer.decode([id]).includes('\ufffd')) {
        partial = id;
        break;
    }
}
assert.ok(
    partial >= 0,
    'the vocabulary must carry pieces that split a utf-8 sequence',
);
assert.equal(tokenizer.decode([partial]), '\ufffd');

const encoded = [
    ['Hello, world!', [15947, 11, 1002, 0]],
    [' the quick brown fox', [264, 1702, 6292, 21026]],
    ["don't stop", [13966, 380, 1590]],
    ['你好，世界', [26410, 171, 120, 234, 24486]],
    ['music 音乐 123', [7572, 220, 18034, 44365, 34466]],
    ['😀 emoji 🎵', [13125, 222, 31595, 25674]],
    ['line\nbreak\ttab', [1889, 198, 13225, 197, 83, 455]],
    ['  double  spaces  ', [220, 3834, 220, 7673, 220, 220]],
    [
        'ellipsis...and, punctuation!',
        [898, 2600, 271, 485, 474, 11, 27006, 16073, 0],
    ],
    ['', []],
    ['中文abc日本語', [5975, 17174, 455, 66, 27311, 31348]],
    ['Café naïve résumé', [34, 2792, 526, 1667, 15487, 303, 14415, 449, 526]],
    ['ALL CAPS and MiXeD', [15921, 33636, 50, 293, 10204, 55, 68, 35]],
    ['a<|notimestamps|>b<|0.00|>', [64, 50363, 65, 50364]],
    [
        '<|startoftranscript|><|en|><|transcribe|>Hello there',
        [50258, 50259, 50359, 15947, 456],
    ],
];
for (const [text, ids] of encoded) {
    assert.deepEqual(
        tokenizer.encode(text),
        ids,
        `encoding ${JSON.stringify(text)}`,
    );
}

assert.equal(
    tokenizer.decode(tokenizer.encode('Hello there, friend')),
    'Hello there, friend',
);

assert.throws(
    () => tokenizer.encode('a<|nope|>b'),
    (error) => error.code === 'invalid-option',
);

assert.throws(
    () => tokenizer.tokenText(-1),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () => tokenizer.decode([tokenizer.vocabSize]),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () => tokenizer.timestampSeconds(0),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () => inspectWhisperTokenizer({ id: 'x', settings: {} }, inspected),
    (error) => error.code === 'missing-setting',
);
assert.throws(
    () =>
        inspectWhisperTokenizer(
            { id: 'x', settings: { tokenizer: 'not json' } },
            inspected,
        ),
    (error) => error.code === 'missing-setting',
);
assert.throws(
    () =>
        inspectWhisperTokenizer(
            {
                id: 'x',
                settings: { tokenizer: '{"model":{"type":"WordPiece"}}' },
            },
            inspected,
        ),
    (error) => error.code === 'setting-mismatch',
);
assert.throws(
    () =>
        inspectWhisperTokenizer(
            {
                id: 'x',
                settings: {
                    tokenizer: '{"model":{"type":"BPE","vocab":{"a":99999}}}',
                },
            },
            inspected,
        ),
    (error) => error.code === 'setting-mismatch',
);

console.log(`vocabSize ${tokenizer.vocabSize}`);
console.log(
    `timestamp tokens ${tokenizer.timestampBegin}..${tokenizer.timestampEnd}`,
);
console.log(`first piece that splits a utf-8 sequence: ${partial}`);
console.log('every tokenizer invariant holds');
