# API reference

Everything exported from `@felyrics/stemalign`. Paths in the source tree are
given per section; the barrel is `src/main/index.ts`.

Two rules hold throughout:

- Nothing here reads media from disk or downloads a model.
- Every failure is a `StemalignError` with a `code`, a message and a `context`.

## Models

```ts
type ModelSource = ModelBytes | ModelPath;

interface ModelBytes {
    readonly bytes: Uint8Array;
    readonly externalData?: readonly ExternalDataBytes[];
}

interface ModelPath {
    /** Absolute path to the `.onnx` file. */
    readonly path: string;
}

interface ModelSpec {
    readonly id: string;
    readonly sessions: Readonly<Record<string, ModelSource>>;
    readonly executionProviders?: readonly string[];
    readonly settings?: Readonly<Record<string, string>>;
}
```

`ModelPath` lets ONNX Runtime read the file, and it resolves a sibling
`<model>.onnx_data` on its own. `ModelBytes` needs `externalData` spelled out,
because in memory the package has no directory to look in; `path` there is the
logical name the graph uses internally.

`settings` maps a file name to its full text (`'tokenizer.json'` to the contents
of that file). The alignment side reads `config.json`,
`generation_config.json`, `preprocessor_config.json` and `tokenizer.json` from
it.

`openModel(spec): Promise<ModelHandle>` opens every session up front and throws
`session-create-failed` if one fails.

```ts
interface ModelHandle {
    readonly id: string;
    readonly sessions: ReadonlyMap<string, ModelSession>;
    readonly settings: Readonly<Record<string, string>>;
    release(): Promise<void>;
}

interface ModelSession {
    readonly name: string;
    readonly inputInfo: readonly TensorInfo[];
    readonly outputInfo: readonly TensorInfo[];
    run(feeds: InferenceSession.FeedsType, fetches?: readonly string[]): Promise<InferenceSession.ReturnType>;
    release(): Promise<void>;
}

interface TensorInfo {
    readonly name: string;
    readonly type: TensorType; // Tensor.Type from onnxruntime-node
    readonly shape: TensorShape; // number for fixed, string for symbolic
}
```

`release()` is idempotent; running a released session throws
`session-released`. `run(feeds, fetches)` fetches only named outputs, which is
what keeps large graphs from materialising outputs nobody reads.

`setOrtLogLevel(level: 'verbose' | 'info' | 'warning' | 'error' | 'fatal')` sets
the process wide ONNX Runtime level and must be called before the first session;
afterwards it throws `log-level-too-late`.

## Audio

```ts
interface PcmAudio {
    readonly sampleRate: number;
    readonly channels: readonly Float32Array[];
}

interface PcmAudioInfo {
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly frameCount: number;
}

checkPcmAudio(audio: PcmAudio): PcmAudioInfo
checkSampleRate(value: number, label: string): number
toChannelCount(audio: PcmAudio, count: 1 | 2): PcmAudio
resample(audio: PcmAudio, targetSampleRate: number): PcmAudio
```

Samples are planar float32 in `[-1, 1]`; integer PCM is converted by the caller.
`checkPcmAudio` validates the shape only (positive integer rate, at least one
channel, equal lengths) in `O(channels)`, never per sample; silence and NaN are
the caller's business.

`toChannelCount` returns the same object for a matching count, averages channels
to mono, copies a mono channel to stereo, and rejects anything wider than stereo
with `unsupported-layout` rather than guessing a downmix.

`resample` is a Kaiser windowed sinc (16 zero crossings, beta 8.6) built as an
exact rational polyphase table, and returns the input unchanged when the rate
matches. It is a safety net for rates the caller did not align; decoding at the
model rate keeps the whole pipeline at zero copies.

## Separation

```ts
interface DemucsLayout {
    readonly session: string;
    readonly input: string;
    readonly output: string;
    readonly sampleRate: number;
    readonly channels: number;
    readonly frames: number;
    readonly stems: number;
    readonly tracks: readonly string[];
}

inspectDemucs(handle: ModelHandle, tracks?: readonly string[]): DemucsLayout

interface SeparateOptions {
    readonly tracks?: readonly string[];
    readonly shifts?: number;
    readonly outputSampleRate?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: ProgressReporter;
}

separate(audio: PcmAudio, handle: ModelHandle, options?: SeparateOptions): Promise<readonly Stem[]>

interface Stem {
    readonly track: string;
    readonly audio: PcmAudio;
}
```

`inspectDemucs` reads the chunk length, channel count, stem count and sample
rate from the graph; nothing about Demucs is hard coded except the sample rate
family, the 25% overlap and the track names. The names come from `tracks` when
given (a single stem export), and otherwise from the four or six stem
convention; any other count needs explicit names.

Output is always stereo at the input sample rate unless `outputSampleRate` says
otherwise. `shifts` averages several randomly delayed passes (`1` by default,
matching Demucs; `0` disables it and makes runs reproducible). Progress reports
`{ stage: 'chunk', completed, total }` before the first chunk and after every
later one; the `signal` is checked between chunks only, so cancelling waits for
the chunk in flight.

Lower level, exported for callers that want to drive the chunk loop themselves:

```ts
interface ChunkPlan {
    readonly frames: number;
    readonly overlap: number;
    readonly channels: number;
}

type ChunkRunner = (chunk: PcmAudio, index: number, total: number) => Promise<readonly PcmAudio[]>;

chunkOffsets(frameCount: number, plan: ChunkPlan): readonly number[]
separateChunks(audio: PcmAudio, plan: ChunkPlan, runChunk: ChunkRunner): Promise<readonly PcmAudio[]>

buildShiftDelays(count: number, sampleRate: number): readonly number[]
delayAudio(audio: PcmAudio, delay: number): PcmAudio
MAX_SHIFT_SECONDS // 0.5
DEMUCS_SAMPLE_RATE // 44100
DEMUCS_OVERLAP // 0.25
DEMUCS_SHIFTS // 1
```

The last chunk is padded with zeros and only its real prefix is kept, matching
the packaged Python exporters. The window is a trapezoid whose two ramps
complement each other across a seam, which is why the result is normalised by
the weight sum instead of averaging neighbours.

## Alignment

```ts
align(audio: PcmAudio, text: string, handle: ModelHandle, options?: AlignOptions): Promise<AlignmentResult>
```

The audio is resampled to 16 kHz mono internally. `text` is the lyrics; they are
encoded with the model tokenizer, split into windows by tokens (not by time) and
aligned window by window. Words the decoder cannot place are dropped.

```ts
interface AlignmentResult {
    readonly text: string;
    readonly segments: readonly AlignmentSegment[];
    readonly language: string;
    readonly ori_dict: AlignmentOriginal;
    readonly regroup_history: string;
    readonly nonspeech_sections: readonly AlignmentSilence[];
}

interface AlignmentOriginal {
    readonly text: string;
    readonly segments: readonly AlignmentSegment[];
    readonly language: string;
    readonly ori_dict: Readonly<Record<string, never>>;
    readonly regroup_history: string;
    readonly nonspeech_sections: readonly AlignmentSilence[];
}

interface AlignmentSegment {
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly seek: number | null;
    readonly tokens: readonly number[] | null;
    readonly temperature: number | null;
    readonly avg_logprob: number | null;
    readonly compression_ratio: number | null;
    readonly no_speech_prob: number | null;
    readonly words: readonly WordTiming[];
}

interface WordTiming {
    readonly word: string;
    readonly tokens: readonly number[];
    readonly start: number;
    readonly end: number;
    readonly probability: number;
}
```

This is the `stable_whisper.WhisperResult.to_dict()` shape: `text` is the
concatenation of the surviving segments, not the input lyrics. The segment-level
metadata (`seek`, `avg_logprob`, ...) is `null`/`0` because a forced alignment
never runs a decode loop that could produce it.

`AlignOptions` (all optional): `language` (default `en`), `task`, `tokenStep`
(tokens per window, default 100), `nonspeechSkip`, `minSilenceDur`, `minWordDur`,
`nonspeechError`, `suppressSilence`, `suppressWordTimestamps`,
`useWordPosition`, `regroup` (`true`/`false`/an algorithm string, default the
`da` chain), `wordDurFactor`, `maxWordDur`, `splitWordsBySpace`,
`maxSegmentLength`, `fastMode`, `failureThreshold`, `onProgress`, `signal`.

`onProgress` receives `{ seconds, totalSeconds, finished }`; `finished` is false
when the run bailed out because too many words came back with zero duration.
Cancellation is honoured between windows.

## Alignment stages

The pipeline is exported stage by stage. A caller that wants a different window
policy can run these directly; `align()` is the composition of exactly these.

```ts
// src/main/alignment/whisper.ts
inspectWhisper(handle: ModelHandle): WhisperLayout
WHISPER_ENCODER_DOWNSAMPLE // 2

// src/main/alignment/settings.ts
inspectWhisperSettings(handle: ModelHandle, layout: WhisperLayout): WhisperSettings

// src/main/alignment/tokenizer.ts
inspectWhisperTokenizer(handle: ModelHandle, settings: WhisperSettings): WhisperTokenizer

interface WhisperTokenizer {
    readonly vocabSize: number;
    readonly timestampBegin: number;
    readonly timestampEnd: number;
    tokenText(id: number): string;
    isSpecialToken(id: number): boolean;
    isTimestampToken(id: number): boolean;
    timestampSeconds(id: number): number;
    decode(ids: readonly number[]): string;
    encode(text: string): readonly number[];
}
```

`inspectWhisper` finds the two sessions by their input names (`input_features`,
`input_ids`) and checks that the decoder exposes one `cross_attentions.<layer>`
output per attention layer. `inspectWhisperSettings` parses the four JSON files
out of `ModelSpec.settings` and cross-checks them against each other
(`nbMaxFrames * hopLength === chunkLength * sampleRate`, and so on).

```ts
// src/main/alignment/mel.ts
melSpectrogram(audio: PcmAudio, settings: WhisperSettings, maximum?: number): MelBlock
melLogPower(audio: PcmAudio, settings: WhisperSettings): MelBlock
melMaximum(block: MelBlock): number
normalizeMel(block: MelBlock, maximum: number): MelBlock
MEL_FLOOR // 1e-10
MEL_DYNAMIC_RANGE // 8
MEL_OFFSET // 4
MEL_SCALE // 4

interface MelBlock {
    readonly melBins: number;
    readonly frames: number;
    readonly values: Float32Array;
}

// src/main/alignment/mel-filters.ts
buildMelFilters(sampleRate: number, nFft: number, melBins: number): MelFilters

// src/main/alignment/encoder.ts
runEncoder(handle: ModelHandle, layout: WhisperLayout, settings: WhisperSettings, mel: MelBlock): Promise<Float32Array>

// src/main/alignment/decoder.ts
runDecoder(handle: ModelHandle, layout: WhisperLayout, settings: WhisperSettings, request: DecoderRequest): Promise<DecoderPass>
emittedTokenProbabilities(logits: Float32Array, vocabSize: number, eot: number, tokenIds: readonly number[]): Float64Array

interface DecoderRequest {
    readonly hiddenStates: Float32Array;
    readonly tokenIds: readonly number[];
}

interface DecoderPass {
    readonly tokens: number;
    readonly frames: number;
    readonly probabilities: Float64Array;
    readonly attentions: readonly DecoderAttention[];
}

// src/main/alignment/attention.ts
computeAttentionWeights(pass: DecoderPass, settings: WhisperSettings, options: AttentionOptions): AttenWeights

interface AttentionOptions {
    readonly sotLen: number;
    readonly numSamples: number;
    readonly qkScale?: number;
    readonly medfiltWidth?: number;
}

interface AttenWeights {
    readonly weights: Float32Array; // [heads, tokens, frames]
    readonly nHeads: number;
    readonly nTokens: number;
    readonly nFrames: number;
    readonly maxQkLen: number;
}

// src/main/alignment/dtw.ts
dtwPath(costs: Float32Array, rows: number, columns: number): DtwPath

// src/main/alignment/jumps.ts
computeJumpIndices(attention: AttenWeights): JumpIndices

// src/main/alignment/words.ts
splitWords(tokenizer: WhisperTokenizer, tokenIds: readonly number[], options?: WordSplitOptions): WordSplit
stripWord(word: string): string
DEFAULT_PREPEND_PUNCTUATIONS
DEFAULT_APPEND_PUNCTUATIONS

// src/main/alignment/timestamps.ts
wordTimings(split: WordSplit, jumps: JumpIndices, settings: WhisperSettings, options?: TimingOptions): readonly WordTiming[]

// src/main/alignment/clamp.ts
clampWords(words: readonly WordTiming[], options?: ClampOptions): readonly WordTiming[]
```

`runDecoder` performs one full forward pass: the decoder export bundles both
cache branches behind an `If`, and cached decoding is not usable from ONNX
Runtime, so the past tensors are fed as zero-length placeholders and the branch
flag is always false. This is enough for forced alignment, which needs the cross
attention of a known sequence, not generated tokens.

## Silence suppression and regroup

```ts
// src/main/alignment/non-speech.ts
silenceMask(audio: PcmAudio, options?: SilenceMaskOptions): Uint8Array | null
maskSpans(mask: Uint8Array | null, secondsPerUnit: number, offset?: number): readonly SilenceSpan[]
filterSilences(spans: readonly SilenceSpan[], minSilenceDur: number): readonly SilenceSpan[]
mergeSilences(spans: readonly SilenceSpan[]): readonly SilenceSpan[]
nonSilentUnits(mask: Uint8Array): number
SILENCE_UNIT_SAMPLES // 320

// src/main/alignment/suppress-silence.ts
suppressSilence(word: WordSpan, silences: readonly SilenceSpan[], options: SuppressSilenceOptions): WordSpan

// src/main/alignment/segment.ts
makeSegment(words: readonly WordTiming[], meta?: Partial<SegmentMeta>): AlignmentSegment
splitSegmentByChars(words: readonly WordTiming[], charIndexes: readonly number[], meta?: Partial<SegmentMeta>): readonly AlignmentSegment[]
suppressSegmentSilence(segment: AlignmentSegment, silences: readonly SilenceSpan[], options: SegmentSuppressOptions): AlignmentSegment

// src/main/alignment/regroup.ts
regroupSegments(segments: readonly AlignmentSegment[], options?: RegroupOptions): RegroupResult
parseRegroupAlgo(algo: string): readonly RegroupCall[]
DEFAULT_REGROUP_ALGO // 'da'

interface RegroupResult {
    readonly segments: readonly AlignmentSegment[];
    readonly history: string;
}
```

`silenceMask` turns audio into one byte per 320 samples (1 = silence) with the
stable-ts loudness quantisation, then inside the pipeline those units are
converted to spans and applied per segment: the first and last word of each
segment are trimmed, a trailing punctuation or the word position decides which
edge gives way, and the other words are left alone. `regroupSegments` then
re-splits the segments into sentences with the stable-ts `da` chain
(`isp`, `cm`, `sp`, `sg`, `sl`) and records the applied calls in `history`.

`makeSegment` derives a segment's start, end and text from its words, exactly
like `stable_whisper.Segment` with `ignore_unused_args=True`.

## Progress and errors

```ts
interface SeparationProgress {
    readonly stage: 'chunk';
    readonly completed: number;
    readonly total: number;
}

type ProgressEvent = SeparationProgress;
type ProgressReporter = (event: ProgressEvent) => void;

type StemalignErrorCode =
    | 'invalid-option'
    | 'invalid-pcm'
    | 'unsupported-layout'
    | 'model-invalid'
    | 'session-create-failed'
    | 'session-released'
    | 'log-level-too-late'
    | 'release-failed'
    | 'missing-setting'
    | 'setting-mismatch'
    | 'unknown-tensor'
    | 'unsupported-dtype'
    | 'cancelled';

interface StemalignErrorContext {
    readonly modelId?: string;
    readonly session?: string;
    readonly tensor?: string;
    readonly expected?: string;
    readonly actual?: string;
}

class StemalignError extends Error {
    readonly code: StemalignErrorCode;
    readonly context: StemalignErrorContext;
}
```

Errors carry the ONNX Runtime failure in `cause`. Progress callbacks are called
synchronously and must be fast; throttling belongs to the caller.
