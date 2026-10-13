import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectWhisperSettings } from '../../../out/main/alignment/settings.js';
import { inspectWhisperTokenizer } from '../../../out/main/alignment/tokenizer.js';
import {
    DEFAULT_APPEND_PUNCTUATIONS,
    DEFAULT_PREPEND_PUNCTUATIONS,
    splitWords,
} from '../../../out/main/alignment/words.js';

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

// reference/whisper/src/constants.mjs:31-35 spells these out as
//   "\"'“¿([{-「"   and   "\"'.。,，!！?？:：”)]}、」"
assert.equal(DEFAULT_PREPEND_PUNCTUATIONS, `"'“¿([{-「`);
assert.equal(DEFAULT_APPEND_PUNCTUATIONS, `"'.。,，!！?？:：”)]}、」`);

// Expectations produced by running the reference implementation
// (reference/whisper/src/text-utils.mjs tokensToWordTokens) over whisper-base.
// When byPiece is omitted it must equal bySpace.
const expectations = [
    {
        text: 'Hello, world!',
        bySpace: {
            words: ['Hello,', ' world!'],
            tokens: [
                [15947, 11],
                [1002, 0],
            ],
        },
    },
    {
        text: ' the quick brown fox',
        bySpace: {
            words: [' the', ' quick', ' brown', ' fox'],
            tokens: [[264], [1702], [6292], [21026]],
        },
    },
    {
        text: "don't stop",
        bySpace: {
            words: ["don't", ' stop'],
            tokens: [[13966, 380], [1590]],
        },
        byPiece: {
            words: ['don', "'t", ' stop'],
            tokens: [[13966], [380], [1590]],
        },
    },
    {
        text: '你好，世界',
        bySpace: {
            words: ['你好，世界'],
            tokens: [[26410, 171, 120, 234, 24486]],
        },
        byPiece: {
            words: ['你好，', '世界'],
            tokens: [[26410, 171, 120, 234], [24486]],
        },
    },
    {
        text: 'music 音乐 123',
        bySpace: {
            words: ['music', ' 音乐', ' 123'],
            tokens: [[7572], [220, 18034, 44365], [34466]],
        },
        byPiece: {
            words: ['music', ' 音', '乐', ' 123'],
            tokens: [[7572], [220, 18034], [44365], [34466]],
        },
    },
    {
        text: '😀 emoji 🎵',
        bySpace: {
            words: ['😀', ' emoji', ' 🎵'],
            tokens: [[13125, 222], [31595], [25674]],
        },
    },
    {
        text: 'line\nbreak\ttab',
        bySpace: {
            words: ['line\nbreak\ttab'],
            tokens: [[1889, 198, 13225, 197, 83, 455]],
        },
        byPiece: {
            words: ['line', '\n', 'break', '\t', 't', 'ab'],
            tokens: [[1889], [198], [13225], [197], [83], [455]],
        },
    },
    {
        text: '  double  spaces  ',
        bySpace: {
            words: ['  double', '  spaces', '  '],
            tokens: [
                [220, 3834],
                [220, 7673],
                [220, 220],
            ],
        },
    },
    {
        text: '(parentheses) [brackets] {braces}',
        bySpace: {
            words: ['(parentheses)', ' [brackets]', ' {braces}'],
            tokens: [
                [7, 79, 20616, 23639, 8],
                [542, 1443, 501, 1385, 60],
                [10929, 1443, 2116, 92],
            ],
        },
        byPiece: {
            words: [
                '(',
                'p',
                'arenth',
                'eses)',
                ' [br',
                'ack',
                'ets]',
                ' {br',
                'aces}',
            ],
            tokens: [
                [7],
                [79],
                [20616],
                [23639, 8],
                [542, 1443],
                [501],
                [1385, 60],
                [10929, 1443],
                [2116, 92],
            ],
        },
    },
    {
        text: 'ellipsis...and, punctuation!',
        bySpace: {
            words: ['ellipsis...and,', ' punctuation!'],
            tokens: [
                [898, 2600, 271, 485, 474, 11],
                [27006, 16073, 0],
            ],
        },
        byPiece: {
            words: ['ell', 'ips', 'is', '...', 'and,', ' punct', 'uation!'],
            tokens: [
                [898],
                [2600],
                [271],
                [485],
                [474, 11],
                [27006],
                [16073, 0],
            ],
        },
    },
    {
        text: '"quoted" text',
        bySpace: {
            words: ['"quoted"', ' text'],
            tokens: [[1, 358, 23325, 1], [2487]],
        },
        byPiece: {
            words: ['"', 'qu', 'oted"', ' text'],
            tokens: [[1], [358], [23325, 1], [2487]],
        },
    },
    {
        text: '',
        bySpace: { words: [], tokens: [] },
    },
];

let groupCount = 0;

for (const expectation of expectations) {
    const ids = tokenizer.encode(expectation.text);
    assert.equal(
        tokenizer.decode(ids),
        expectation.text,
        `round trip of ${JSON.stringify(expectation.text)}`,
    );

    const bySpace = splitWords(tokenizer, ids, { splitBySpace: true });
    const byPiece = splitWords(tokenizer, ids, { splitBySpace: false });

    assert.deepEqual(
        bySpace,
        expectation.bySpace,
        `space split of ${JSON.stringify(expectation.text)}`,
    );
    assert.deepEqual(
        byPiece,
        expectation.byPiece ?? expectation.bySpace,
        `piece split of ${JSON.stringify(expectation.text)}`,
    );
}

for (const { text } of expectations) {
    const ids = tokenizer.encode(text);

    for (const splitBySpace of [true, false]) {
        const split = splitWords(tokenizer, ids, { splitBySpace });
        const label = `${JSON.stringify(text)} with splitBySpace ${splitBySpace}`;

        assert.equal(
            split.words.length,
            split.tokens.length,
            `${label}: one group per word`,
        );
        assert.deepEqual(
            split.tokens.flat(),
            [...ids],
            `${label}: the groups partition the tokens`,
        );
        assert.equal(
            split.words.join(''),
            text,
            `${label}: the words spell the text`,
        );

        for (let index = 0; index < split.words.length; index += 1) {
            const word = split.words[index];
            assert.ok(word.length > 0, `${label}: no empty word`);
            assert.ok(
                split.tokens[index].length > 0,
                `${label}: no empty group`,
            );
            assert.equal(
                tokenizer.decode(split.tokens[index]),
                word,
                `${label}: group ${index}`,
            );
        }

        groupCount += split.words.length;
    }
}

assert.deepEqual(
    splitWords(tokenizer, tokenizer.encode('Hello, world!')),
    {
        words: ['Hello,', ' world!'],
        tokens: [
            [15947, 11],
            [1002, 0],
        ],
    },
    'the default options split by space',
);

assert.throws(
    () => splitWords(tokenizer, [64], { splitBySpace: 'yes' }),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () => splitWords(tokenizer, [64], { prependPunctuations: 5 }),
    (error) => error.code === 'invalid-option',
);
assert.throws(
    () => splitWords(tokenizer, [-1]),
    (error) => error.code === 'invalid-option',
);

console.log(`matched ${expectations.length} reference splits in both modes`);
console.log(`every word split invariant holds over ${groupCount} groups`);
