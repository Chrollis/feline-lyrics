# @felyrics/stemalign

ONNX-backed source separation and forced alignment for Felyrics.

The package takes an already-decoded audio buffer plus ONNX model bytes. It
returns either one audio buffer per stem, or word-level timings grouped into
sentences for a lyric text. It never touches the filesystem, the network or an
audio decoder:
reading model files, decoding audio and writing results are the caller's job.

- Separation and forced alignment are both implemented and verified, and both
  are exported from the package root.
- The package is not published to npm yet.
- Requires Node.js 22.12 or newer and `onnxruntime-node` 1.30 or newer.

## Install

```sh
npm install @felyrics/stemalign onnxruntime-node
```

## Separate

```ts
import { readFile } from 'node:fs/promises';
import { openModel, separate } from '@felyrics/stemalign';

const handle = await openModel({
    id: 'htdemucs',
    sessions: { model: { bytes: await readFile('htdemucs.onnx') } },
    executionProviders: ['webgpu', 'cpu'],
});
try {
    const stems = await separate(
        { sampleRate: 48000, channels: [left, right] },
        handle,
        { onProgress: (event) => console.log(event.completed, event.total) },
    );
    for (const stem of stems) {
        console.log(stem.track, stem.audio.sampleRate);
    }
} finally {
    await handle.release();
}
```

`left` and `right` are `Float32Array` channels decoded by the caller. The input
is resampled to the model's rate, and every stem is resampled back to the input
rate unless `outputSampleRate` says otherwise. Stems arrive with the model's
channel count; folding them to mono is the caller's decision. One separation
averages a randomly shifted pass by default (`shifts: 1`, the Demucs default),
so runs are not reproducible; pass `shifts: 0` when a stable result matters.

## Align

```ts
import { align, openModel } from '@felyrics/stemalign';

const handle = await openModel({
    id: 'whisper-base',
    sessions: { encoder: { path: encoderPath }, decoder: { path: decoderPath } },
    settings: {
        // file contents, not file paths
        config, generation, preprocessor, tokenizer,
    },
    executionProviders: ['dml', 'cpu'],
});
try {
    const result = await align(audio, lyrics, handle, { language: 'ja' });
    for (const segment of result.segments) {
        for (const word of segment.words) {
            console.log(word.word, word.start, word.end, word.probability);
        }
    }
} finally {
    await handle.release();
}
```

`encoderPath` and `decoderPath` are absolute paths to the Whisper pair; a
`*_data` sidecar next to the graph is resolved by ONNX Runtime itself. The
result mirrors `stable_whisper.WhisperResult.to_dict()`:

```ts
interface AlignmentResult {
    text: string;
    segments: readonly AlignmentSegment[];
    language: string;
    ori_dict: AlignmentOriginal;
    regroup_history: string;
    nonspeech_sections: readonly AlignmentSilence[];
}
```

- there is no flat word list: the words live inside a segment, so flatten with
  `result.segments.flatMap((segment) => segment.words)`
- `text` is the surviving segments concatenated, not the input lyrics: a word
  the model could not place is dropped rather than guessed, so it can be shorter
  than what was passed in
- a segment is what `Segment.to_dict()` reports: `start`, `end` and `text`, the
  `words` it holds, plus the metadata it carries (`seek`, `tokens`,
  `temperature`, `avg_logprob`, `compression_ratio`, `no_speech_prob`), which is
  `null` where the model gave nothing
- a word is one `{ word, tokens, start, end, probability }`: a start and an end
  in floating-point seconds, rounded to three decimals (banker's rounding)
- `ori_dict` is the snapshot taken after suppression and before regrouping,
  `regroup_history` is the calls that ran, and `nonspeech_sections` is the
  merged silence, filled only while suppressing
- pass `splitWordsBySpace: false` for languages written without spaces, such as
  Chinese or Japanese

The switches keep the stable_ts defaults, and each can be turned off:

- `suppressSilence` (`true`) suppresses the words that fall inside a detected
  silence
- `suppressWordTimestamps` (`true`) suppresses every word of a segment; with
  `false` only the first and the last word are touched
- `useWordPosition` (`true`) lets the trailing punctuation and the position of
  the word decide which edge survives
- `regroup` (`'da'`) regroups the suppressed words into sentences with the
  stable_ts algorithm; `false` leaves one flat segment per run, any other string
  is an algorithm string for `regroupSegments`, and an unknown call is rejected

`regroup.ts` ports `WhisperResult.regroup`, for the default algorithm only
(`isp`, `cm`, `sg`, `sp` and `sl`). stable-ts models word locks and some of its
methods exist only to move them around, so a lock request is rejected instead of
being ignored. The pieces are exported too: `makeSegment`,
`splitSegmentByChars`, `suppressSegmentSilence`, `regroupSegments`,
`parseRegroupAlgo` and `DEFAULT_REGROUP_ALGO`.

This is not the only alignment route in Felyrics. Here the Whisper pair runs on
whatever execution providers the caller names, and that is what sets the model
ceiling: the large-v3 export carries about 6 GB of fp32 weights, so a small GPU
stops at medium. The Python service is meant to cover the same ground with
faster-whisper (CTranslate2, int8) on the CPU, where large-v3 is affordable,
and it can transcribe when no lyrics exist yet. Which route to use is the
caller's decision, not this package's.

## What it does not do

- no model download, no audio decoding, no `ffmpeg`, no file access of its own
- no execution provider fallback and no mid-run cancellation: both are caller
  decisions, not defaults
- no downmix from more than two channels, no parallel chunks, no model
  ensembles, no two-stems or clip-mode post-processing

## Audio contract

`PcmAudio` is `{ sampleRate: number; channels: readonly Float32Array[] }`.

- planar layout, one array per channel, never interleaved
- float32 samples only: converting integer PCM and normalizing are the
  caller's job, and no clipping or limiting is applied here
- `sampleRate` is a positive integer, there is at least one channel, and every
  channel has the same length
- more than two channels is rejected (`unsupported-layout`); there is no
  implicit downmix
- resampling happens inside the package, and only when the rates differ

## Model contract

```ts
openModel({
    id: string,
    sessions: Record<string, ModelSource>,
    executionProviders?: readonly string[],
    settings?: Readonly<Record<string, string>>,
});
```

`ModelSource` is `ModelBytes | ModelPath`, and the union is the point:

- `ModelBytes` (`{ bytes, externalData? }`) keeps the graph in the JS heap.
  `externalData[].path` is the logical name the `.onnx` file refers to
  internally, not a disk path. One `Uint8Array` is capped at 4 GiB on 64-bit
  Node, so a multi-gigabyte export cannot take this route.
- `ModelPath` (`{ path }`) hands the reading to ONNX Runtime, which also
  resolves a `*_data` sidecar from the graph's own directory, so the weights
  never enter the JS heap. The path must be absolute: a relative one is
  resolved against the process working directory.
- `settings` is a string table of settings file *contents*, not paths.

Each model family adds its own requirements, checked when the session is
created:

- Demucs (`inspectDemucs`): one session, one input `float32 [1, 2, frames]`,
  one output `float32 | float16 [1, stems, 2, frames]`; `frames` comes from the
  model metadata, never a constant; 4- and 6-stem exports get the conventional
  track order (`drums, bass, other, vocals[, guitar, piano]`) and any other
  count needs explicit `tracks`; fp16 weights are fine as long as the graph
  boundary stays `float32` (about half the size, same output), while an `int8`
  or `float16` input boundary is rejected (`unsupported-dtype`)
- Whisper (`inspectWhisper`): two sessions, `encoder` and `decoder`, plus four
  `settings` entries named `config`, `generation`, `preprocessor` and
  `tokenizer`

## Execution providers

- `executionProviders` is a caller-supplied preference order, and the right
  list is model-specific: `['webgpu', 'cpu']` for the Demucs exports and
  `['dml', 'cpu']` for the Whisper ones, on the machine measured below
- there is no silent fallback: if the preferred provider fails, the call fails,
  and it can fail as late as the first tensor being computed
- the first run on WebGPU pays shader compilation (about 1.2 s), so the first
  chunk is slower than the rest

## Progress

```ts
interface SeparationProgress { stage: 'chunk'; completed: number; total: number }
interface AlignProgress { seconds: number; totalSeconds: number; finished: boolean }
```

- one stage per operation: separation counts chunks, alignment counts seconds,
  and counts are never summed across stages, so a caller builds one bar per
  `stage`
- the first separation event has `completed: 0`, which is when `total` becomes
  known; one event follows every chunk and the last one has
  `completed === total`
- a failed or cancelled run stops emitting and never reports completion
- the callback is synchronous and not awaited: keep it fast
- no timestamps are reported: elapsed time and the estimate of what is left
  belong to the consumer, which owns the clock it renders with

## Cancellation

Pass `signal` in the options.

- it is checked between chunks, so an aborted run throws `StemalignError` with
  code `cancelled` and emits no further progress
- ONNX Runtime cannot interrupt a running `session.run()`
  (`RunOptions.terminate` exists on the WASM backend only), so an abort lands
  after the current chunk: about 0.7 s on WebGPU and 2.5 s on CPU for a 7.8 s
  chunk here
- work before the chunk loop (validation, resampling) is not cancellable

## Errors

Every rejection is a `StemalignError` carrying a `code`, a readable message and
`context: { modelId?, session?, tensor?, expected?, actual? }`, with the
original error in `cause`. Codes: `invalid-pcm`, `invalid-option`,
`unsupported-layout`, `model-invalid`, `session-create-failed`,
`session-released`, `log-level-too-late`, `release-failed`, `missing-setting`,
`setting-mismatch`, `unknown-tensor`, `unsupported-dtype`, `cancelled`.

## Logging

`setOrtLogLevel(level)` sets the process-wide ONNX Runtime level (`'verbose'`,
`'info'`, `'warning'`, `'error'`, `'fatal'`) and must be called before the first
session is created; a later call throws `log-level-too-late`. On the current ORT
build the per-session `logSeverityLevel` option has no effect: only the
process-level setting produces output. The package itself never logs.

## Performance

On one RTX 4060, a 44.1 kHz stereo mix through the htdemucs export: about 4.5 s
to open the 316 MB float32 graph, then about 0.73 s per 7.8 s chunk on WebGPU
(roughly 10x realtime) and 2.5 s on CPU. Stems sum back to the mix within about
0.04 for the 4-stem export and about 0.24 for the 6-stem one.

## License

MPL-2.0. See the repository's `LICENSE` file.
