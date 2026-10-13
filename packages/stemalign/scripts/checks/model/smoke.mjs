import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { Tensor } from 'onnxruntime-node';

import { openModel, setOrtLogLevel } from '../../../out/main/index.js';

const EXPECTED_SHAPES = {
    mix: [1, 2, 343980],
    stems: [1, 4, 2, 343980],
};

const modelPath = process.argv[2];
if (modelPath === undefined) {
    console.error('usage: node scripts/smoke.mjs <path to htdemucs.onnx>');
    process.exit(2);
}

const bytes = await readFile(modelPath);
console.log(`read ${bytes.byteLength} bytes from ${modelPath}`);

setOrtLogLevel('warning');

const startedAt = Date.now();
const handle = await openModel({
    id: 'htdemucs',
    sessions: { model: { bytes } },
    executionProviders: ['webgpu', 'cpu'],
});
console.log(`opened "${handle.id}" in ${Date.now() - startedAt} ms`);

try {
    assert.equal(handle.sessions.size, 1, 'expected exactly one session');
    assert.deepEqual(
        handle.settings,
        {},
        'a bare model must carry no settings',
    );

    const session = handle.sessions.get('model');
    assert.ok(session !== undefined, 'session "model" must exist');

    const actualShapes = new Map();
    const sides = [
        ['input', session.inputInfo],
        ['output', session.outputInfo],
    ];
    for (const [side, infos] of sides) {
        for (const info of infos) {
            actualShapes.set(info.name, info.shape);
            console.log(
                `${side.padEnd(6)} ${info.name} ${info.type} [${info.shape.join(', ')}]`,
            );
        }
    }

    for (const [name, shape] of Object.entries(EXPECTED_SHAPES)) {
        assert.deepEqual(actualShapes.get(name), shape, `shape of "${name}"`);
    }
    console.log('all expected shapes matched');

    const frames = 343980;
    const mix = new Float32Array(2 * frames);
    for (let i = 0; i < mix.length; i += 1) {
        mix[i] = Math.random() * 2 - 1;
    }

    for (const pass of [1, 2]) {
        const runStart = Date.now();
        const outputs = await session.run({
            mix: new Tensor('float32', mix, [1, 2, frames]),
        });
        const elapsed = Date.now() - runStart;
        console.log(
            `pass ${pass}: ${elapsed} ms = ${(elapsed / 7800).toFixed(2)}x realtime`,
        );

        if (pass === 1) {
            const stems = outputs.stems;
            assert.ok(
                stems !== undefined,
                'run() must return an output named "stems"',
            );
            assert.deepEqual(
                stems.dims,
                [1, 4, 2, frames],
                'shape of "stems" from run()',
            );
            assert.ok(
                stems.data instanceof Float32Array,
                '"stems" data must be a Float32Array',
            );
            assert.ok(
                stems.data.every(Number.isFinite),
                '"stems" must contain only finite numbers',
            );
        }
    }

    await handle.release();
    await assert.rejects(() => session.run({}), /already released/);
    console.log('release is idempotent and run() refuses after it');
} finally {
    await handle.release();
}
