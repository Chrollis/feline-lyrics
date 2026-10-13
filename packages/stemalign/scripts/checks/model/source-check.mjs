import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openModel, setOrtLogLevel } from '../../../out/main/index.js';

const directory = fileURLToPath(
    new URL('../../../../../models/Xenova/whisper-base/', import.meta.url),
);
const encoderPath = join(directory, 'onnx', 'encoder_model.onnx');

setOrtLogLevel('error');

await assert.rejects(
    openModel({
        id: 'relative',
        sessions: {
            encoder: {
                path: 'models/Xenova/whisper-base/onnx/encoder_model.onnx',
            },
        },
        executionProviders: ['cpu'],
    }),
    (error) => error.code === 'invalid-option',
);
console.log('a relative model path is rejected as invalid-option');

const bytes = await readFile(encoderPath);
const fromBytes = await openModel({
    id: 'bytes',
    sessions: { encoder: { bytes } },
    executionProviders: ['cpu'],
});
console.log(`the bytes form opens ${bytes.byteLength} bytes`);

const fromPath = await openModel({
    id: 'path',
    sessions: { encoder: { path: encoderPath } },
    executionProviders: ['cpu'],
});

const graphOf = (handle) => handle.sessions.get('encoder');
const bytesGraph = graphOf(fromBytes);
const pathGraph = graphOf(fromPath);
assert.ok(bytesGraph.inputInfo.length > 0);
assert.deepEqual(pathGraph.inputInfo, bytesGraph.inputInfo);
assert.deepEqual(pathGraph.outputInfo, bytesGraph.outputInfo);
const names = bytesGraph.inputInfo.map((item) => item.name);
console.log(`both forms report the same graph: ${names.join(', ')}`);

await fromBytes.release();
await fromPath.release();
console.log('every model source invariant holds');
