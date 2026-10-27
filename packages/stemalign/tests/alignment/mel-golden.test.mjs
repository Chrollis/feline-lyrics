import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { melSpectrogram } from '../../src/main/alignment/mel.js';
import { describe, it } from 'node:test';

describe('mel golden', () => {
    it('matches the torch golden', async () => {
        const manifestUrl = new URL(
            '../fixtures/mel-golden.json',
            import.meta.url,
        );
        const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));

        const settings = {
            sampleRate: manifest.sampleRate,
            melBins: manifest.melBins,
            nFft: manifest.nFft,
            hopLength: manifest.hopLength,
            chunkLength: manifest.nSamples / manifest.sampleRate,
            nbMaxFrames: manifest.nbMaxFrames,
            nSamples: manifest.nSamples,
        };

        function readFloat32(file, expectedSha256) {
            const bytes = readFileSync(new URL(file, manifestUrl));
            assert.equal(
                createHash('sha256').update(bytes).digest('hex'),
                expectedSha256,
                `${file} must match the manifest`,
            );
            const values = new Float32Array(bytes.length / 4);
            for (let index = 0; index < values.length; index += 1) {
                values[index] = bytes.readFloatLE(index * 4);
            }
            return values;
        }

        const samples = readFloat32(manifest.inputFile, manifest.inputSha256);
        const expected = readFloat32(
            manifest.outputFile,
            manifest.outputSha256,
        );
        assert.equal(samples.length, manifest.inputSamples);
        assert.equal(
            expected.length,
            manifest.outputMelBins * manifest.outputFrames,
        );

        const block = melSpectrogram(
            { sampleRate: manifest.sampleRate, channels: [samples] },
            settings,
        );
        assert.equal(block.melBins, manifest.outputMelBins);
        assert.equal(block.frames, manifest.outputFrames);

        let worst = 0;
        let worstIndex = 0;
        for (let index = 0; index < expected.length; index += 1) {
            const difference = Math.abs(block.values[index] - expected[index]);
            if (difference > worst) {
                worst = difference;
                worstIndex = index;
            }
        }
        console.log(`worst difference against the torch golden: ${worst}`);
        console.log(
            `at mel ${Math.floor(worstIndex / manifest.outputFrames)} frame ${worstIndex % manifest.outputFrames}`,
        );
        assert.ok(
            worst <= 5e-4,
            `mel must match the torch golden, worst difference ${worst}`,
        );
        console.log(
            `compared ${expected.length} mel values built with torch ${manifest.torchVersion}`,
        );
    });
});
