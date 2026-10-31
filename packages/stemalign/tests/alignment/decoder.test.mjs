import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Tensor } from 'onnxruntime-node';
import {
    emittedTokenProbabilities,
    runDecoder,
} from '../../src/main/alignment/decoder.js';

/** Float32 logits with one row of `width` values per token id. */
function logits(rows) {
    return Float32Array.from(rows.flat());
}

describe('emittedTokenProbabilities', () => {
    it('scores tokenIds[row + 1] from row row', async () => {
        const probabilities = emittedTokenProbabilities(
            logits([
                [0, Math.log(3), 0, 99],
                [Math.log(2), 0, 0, 0],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
            ]),
            4,
            3,
            [9, 1, 2, 5],
        );

        assert.equal(probabilities.length, 3);
        // Row 0 emits id 1: softmax over ids 0..2 is 3 / (1 + 3 + 1).
        assert.ok(Math.abs(probabilities[0] - 0.6) < 1e-6);
        // Row 1 emits id 2: softmax over ids 0..2 is 1 / (2 + 1 + 1).
        assert.ok(Math.abs(probabilities[1] - 0.25) < 1e-6);
        // Row 2 emits id 5, past the end of text token: no probability.
        assert.equal(probabilities[2], 0);

        console.log(
            'probability row 0 belongs to the second token, not the first',
        );
    });

    it('returns nothing for a single token and zero for an id past the end', async () => {
        assert.deepEqual(
            emittedTokenProbabilities(logits([[0, 0, 0, 0]]), 4, 3, [9]),
            new Float64Array(0),
        );
        assert.deepEqual(
            emittedTokenProbabilities(
                logits([
                    [0, 0, 0, 0],
                    [0, 0, 0, 0],
                ]),
                4,
                3,
                [9, -2],
            ),
            Float64Array.from([0]),
        );
    });

    it('covers only ids below the end of text token', async () => {
        // With eot = 1 the softmax has a single candidate, so id 0 always wins.
        assert.deepEqual(
            emittedTokenProbabilities(
                logits([
                    [0, 0, 0, 0],
                    [0, 0, 0, 0],
                ]),
                4,
                1,
                [7, 0],
            ),
            Float64Array.from([1]),
        );
    });

    it('rejects logits that do not match the token count', async () => {
        assert.throws(
            () => emittedTokenProbabilities(new Float32Array(4), 4, 3, [9, 1]),
            (error) => error.code === 'invalid-option',
        );
        assert.throws(
            () => emittedTokenProbabilities(new Float32Array(8), 4, 0, [9, 1]),
            (error) => error.code === 'invalid-option',
        );
    });
});

// runDecoder reads only the layout names and a handful of settings, so these
// are the smallest shapes it accepts: two frames of two heads of four values,
// two decoder tokens and an eight id vocabulary.
const LAYOUT = {
    encoder: 'encoder',
    decoder: 'decoder',
    melInput: { name: 'input_features' },
    hiddenState: { name: 'hidden_states' },
    inputIds: { name: 'input_ids' },
    encoderStates: { name: 'encoder_hidden_states' },
    useCacheBranch: { name: 'use_cache_branch' },
    logits: { name: 'logits' },
    crossAttentions: [
        { name: 'cross_attentions.0' },
        { name: 'cross_attentions.1' },
    ],
    past: [],
    present: [],
    layers: 2,
    heads: 2,
    headDim: 4,
    vocabSize: 8,
    melBins: 80,
};

const SETTINGS = {
    maxSourcePositions: 2,
    maxTargetPositions: 8,
    vocabSize: 8,
    eosTokenId: 6,
    alignmentHeads: [{ layer: 0, head: 0 }],
};

const REQUEST = {
    hiddenStates: new Float32Array(2 * 2 * 4),
    tokenIds: [3, 5],
};

function handle(output) {
    return {
        id: 'whisper-base',
        sessions: new Map([
            [
                'decoder',
                {
                    name: 'decoder',
                    inputInfo: [],
                    outputInfo: [],
                    async run() {
                        return output;
                    },
                    async release() {},
                },
            ],
        ]),
        settings: {},
        release() {},
    };
}

function logitsTensor() {
    return new Tensor('float32', new Float32Array(2 * 8), [1, 2, 8]);
}

function attentionTensor() {
    return new Tensor('float32', new Float32Array(2 * 2 * 2), [1, 2, 2, 2]);
}

describe('runDecoder output lifetime', () => {
    it('releases both outputs of a completed pass', async () => {
        const logits = logitsTensor();
        const attention = attentionTensor();

        const pass = await runDecoder(
            handle({ logits, 'cross_attentions.0': attention }),
            LAYOUT,
            SETTINGS,
            REQUEST,
        );

        assert.equal(pass.probabilities.length, 1);
        assert.equal(pass.attentions.length, 1);
        assert.equal(logits.location, 'none');
        assert.equal(attention.location, 'none');

        console.log('a completed pass leaves no output tensor behind');
    });

    it('releases the attention tensor when the logits read throws', async () => {
        const logits = new Tensor('int32', new Int32Array(2 * 8), [1, 2, 8]);
        const attention = attentionTensor();

        await assert.rejects(
            runDecoder(
                handle({ logits, 'cross_attentions.0': attention }),
                LAYOUT,
                SETTINGS,
                REQUEST,
            ),
            (error) => error.code === 'unsupported-dtype',
        );
        assert.equal(logits.location, 'none');
        assert.equal(attention.location, 'none');

        console.log('a failed logits read still releases the attention tensor');
    });

    it('releases the attention tensor when the logits output is absent', async () => {
        const attention = attentionTensor();

        await assert.rejects(
            runDecoder(
                handle({ 'cross_attentions.0': attention }),
                LAYOUT,
                SETTINGS,
                REQUEST,
            ),
            (error) => error.code === 'unknown-tensor',
        );
        assert.equal(attention.location, 'none');

        console.log('a missing logits output releases what the run produced');
    });
});
