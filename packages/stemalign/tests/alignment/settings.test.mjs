import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectWhisperSettings } from '../../src/main/alignment/settings.js';
import { describe, it } from 'node:test';

const DIRECTORY = new URL('../fixtures/whisper-base/', import.meta.url);

function fixtureSettings() {
    return {
        config: readFileSync(new URL('config.json', DIRECTORY), 'utf8'),
        generation: readFileSync(
            new URL('generation_config.json', DIRECTORY),
            'utf8',
        ),
        preprocessor: readFileSync(
            new URL('preprocessor_config.json', DIRECTORY),
            'utf8',
        ),
    };
}

function fixtureLayout(config) {
    return {
        layers: config.decoder_layers,
        heads: config.decoder_attention_heads,
        headDim: config.d_model / config.decoder_attention_heads,
        vocabSize: config.vocab_size,
        melBins: config.num_mel_bins,
    };
}

function handleWith(settings) {
    return { id: 'whisper-base', settings };
}

// Rewrites the config fixture with `begin_suppress_tokens` replaced by `value`
// (or removed when the value is undefined).
function configWithout(field, value) {
    const settings = fixtureSettings();
    const config = JSON.parse(settings.config);
    if (value === undefined) {
        delete config[field];
    } else {
        config[field] = value;
    }
    return handleWith({ ...settings, config: JSON.stringify(config) });
}

describe('inspectWhisperSettings suppression lists', () => {
    it('parses both lists when the model ships them', () => {
        const settings = fixtureSettings();
        const config = JSON.parse(settings.config);
        const inspected = inspectWhisperSettings(
            handleWith(settings),
            fixtureLayout(config),
        );

        assert.deepEqual(inspected.beginSuppressTokens, [220, 50257]);
        assert.deepEqual(inspected.suppressTokens, config.suppress_tokens);
        assert.equal(inspected.chunkLength, 30);

        console.log('both suppression lists are parsed for parity');
    });

    it('accepts a config without begin_suppress_tokens', () => {
        const config = JSON.parse(fixtureSettings().config);
        const inspected = inspectWhisperSettings(
            configWithout('begin_suppress_tokens', undefined),
            fixtureLayout(config),
        );

        assert.deepEqual(inspected.beginSuppressTokens, []);
        assert.deepEqual(inspected.suppressTokens, config.suppress_tokens);
        assert.equal(inspected.eosTokenId, 50257);

        console.log('the alignment path needs no begin_suppress_tokens');
    });

    it('still validates begin_suppress_tokens when it is present', () => {
        const config = JSON.parse(fixtureSettings().config);

        assert.throws(
            () =>
                inspectWhisperSettings(
                    configWithout('begin_suppress_tokens', ['not-an-id']),
                    fixtureLayout(config),
                ),
            (error) => error.code === 'missing-setting',
        );

        console.log('a malformed begin_suppress_tokens is still rejected');
    });
});
