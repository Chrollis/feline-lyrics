# @felyrics/stemalign

Vocal separation and forced alignment for Felyrics, on ONNX Runtime only: no
Python, no PyTorch and no audio decoder inside the package.

Separation follows the Demucs ONNX exporters (chunking with overlap-add, shift
averaging). Alignment follows the stable-ts pipeline (mel front end, cross
attention, DTW, regroup, silence suppression) for timing known lyrics against a
track. Both are verified against Python reference goldens.

## Requirements

- Node.js 22.18 or newer (the test suite runs the TypeScript sources directly).
- `onnxruntime-node`, installed as a dependency.
- Model files of your own: this package never downloads anything.

## How it fits

The package deals in samples and bytes. It never opens an audio file, never
decodes one, and never reads a model from disk unless you hand it a path.

- Audio enters as `PcmAudio`: planar `Float32Array` channels at any sample rate.
- Models enter as `ModelSource`: `{ path }` (absolute) or
  `{ bytes, externalData? }` for data already in memory.
- Settings, tokenizer and headers are passed as strings.

`examples/separate.mjs` and `examples/align.mjs` decode with ffmpeg and are the
shortest way to see a complete run.

## Separate a track

```js
import { openModel, separate } from '@felyrics/stemalign';

const handle = await openModel({
    id: 'htdemucs',
    sessions: { model: { path: 'C:/models/htdemucs.onnx' } },
    executionProviders: ['webgpu', 'cpu']
});

try {
    const stems = await separate(audio, handle); // audio: { sampleRate, channels }
    // stems[0].track === 'drums', each with its own PcmAudio
} finally {
    await handle.release();
}
```

## Align lyrics

```js
import { readFileSync } from 'node:fs';
import { align, openModel } from '@felyrics/stemalign';

const settings = {};
for (const name of ['config', 'generation_config', 'preprocessor_config', 'tokenizer']) {
    settings[`${name}.json`] = readFileSync(`${dir}/${name}.json`, 'utf8');
}

const handle = await openModel({
    id: 'whisper-small',
    sessions: {
        encoder: { path: `${dir}/onnx/encoder_model.onnx` },
        decoder: { path: `${dir}/onnx/decoder_model_merged.onnx` }
    },
    executionProviders: ['cpu'],
    settings
});

try {
    const result = await align(audio, lyrics, handle, { language: 'ja' });
    // result: { text, segments, language, ori_dict, regroup_history, nonspeech_sections }
} finally {
    await handle.release();
}
```

## Execution providers

| Models  | Providers           | Why                                                        |
| ------- | ------------------- | ---------------------------------------------------------- |
| Demucs  | `['webgpu', 'cpu']` | 0.73 s per chunk on WebGPU against 2.5 s on the CPU        |
| Whisper | `['cpu']`           | DirectML cannot create these sessions; WebGPU is slower     |

The library never falls back silently: a failing provider fails the call.

## Logging

`setOrtLogLevel('verbose')` sets the ONNX Runtime level for the whole process.
It must run before the first session is created; afterwards it throws
`log-level-too-late`.

## Progress and cancellation

`separate` reports `{ stage: 'chunk', completed, total }` through `onProgress`;
`align` reports `{ seconds, totalSeconds, finished }`. Both callbacks are
synchronous. Both functions take an `AbortSignal`, honoured between chunks or
windows but never inside an inference.

## Errors

Every failure is a `StemalignError` carrying a `code` (`invalid-option`,
`invalid-pcm`, `missing-setting`, `model-invalid`, ...), a human message and a
`context` naming the model, session or tensor involved.

## Lower-level pieces

The barrel exports the stages as well, so a caller can recombine them:
`checkPcmAudio`, `resample`, `chunkOffsets`, `separateChunks`, `melSpectrogram`,
`inspectWhisperTokenizer`, `runEncoder`, `runDecoder`, `computeAttentionWeights`,
`dtwPath`, `computeJumpIndices`, `splitWords`, `wordTimings`, `silenceMask`,
`suppressSilence`, `regroupSegments`. See `docs/api.md`.

## Verification

```sh
npm test
```

The suite runs the sources directly and needs no model download: the goldens in
`tests/fixtures` were produced from Python stable-whisper 2.19.1 by the scripts
next to them.

## Non-goals

No audio decoding, no model download or discovery, no voice activity detection,
no transcription, no model ensembling, no post-processing of the stems.

## License

MPL-2.0.
