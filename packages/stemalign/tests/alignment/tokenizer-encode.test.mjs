import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectWhisperTokenizer } from '../../src/main/alignment/tokenizer.js';
import { describe, it } from 'node:test';

describe('tokenizer encode', () => {
    it('encodes text like the golden', async () => {
        const directory = new URL('../fixtures/whisper-base/', import.meta.url);
        const config = JSON.parse(
            readFileSync(new URL('config.json', directory), 'utf8'),
        );
        const generation = JSON.parse(
            readFileSync(new URL('generation_config.json', directory), 'utf8'),
        );
        const preprocessor = JSON.parse(
            readFileSync(
                new URL('preprocessor_config.json', directory),
                'utf8',
            ),
        );

        const handle = {
            id: 'whisper-base',
            settings: {
                tokenizer: readFileSync(
                    new URL('tokenizer.json', directory),
                    'utf8',
                ),
            },
        };
        const settings = {
            vocabSize: config.vocab_size,
            noTimestampsTokenId: generation.no_timestamps_token_id,
            hopLength: preprocessor.hop_length,
            sampleRate: preprocessor.sampling_rate,
        };

        const golden = JSON.parse(
            readFileSync(
                new URL('../fixtures/tokenizer-golden.json', import.meta.url),
                'utf8',
            ),
        );
        assert.ok(
            golden.cases.length > 0,
            'the golden fixture must carry cases',
        );

        const tokenizer = inspectWhisperTokenizer(handle, settings);
        let tokens = 0;
        for (const [index, item] of golden.cases.entries()) {
            const ids = tokenizer.encode(item.text);
            assert.deepEqual(
                ids,
                item.ids,
                `case ${index} ${JSON.stringify(item.text)}`,
            );
            assert.equal(
                tokenizer.decode(ids),
                item.text,
                `round trip of case ${index} ${JSON.stringify(item.text)}`,
            );
            tokens += ids.length;
        }

        console.log(`case mismatch: none over ${tokens} tokens`);
        console.log(
            `compared ${golden.cases.length} cases with whisper ${golden.whisperVersion} on python ${golden.pythonVersion}`,
        );
        console.log('every encoded case agrees with the whisper tokenizer');
    });
});
