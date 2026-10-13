import { checkPcmAudio } from '../audio/check.js';
import { toChannelCount } from '../audio/channels.js';
import { resample } from '../audio/resample.js';
import type { PcmAudio } from '../audio/types.js';
import { StemalignError } from '../errors.js';
import { ModelHandle } from '../model/session.js';
import { bankersRound } from '../round.js';
import { computeAttentionWeights } from './attention.js';
import { clampWords } from './clamp.js';
import { runDecoder } from './decoder.js';
import { runEncoder } from './encoder.js';
import { computeJumpIndices } from './jumps.js';
import { melSpectrogram } from './mel.js';
import {
    SILENCE_UNIT_SAMPLES,
    filterSilences,
    maskSpans,
    mergeSilences,
    silenceMask,
} from './non-speech.js';
import type { SilenceSpan } from './non-speech.js';
import { suppressSilence } from './suppress-silence.js';
import { inspectWhisper, WHISPER_ENCODER_DOWNSAMPLE } from './whisper.js';
import type { WhisperLayout } from './whisper.js';
import { inspectWhisperSettings } from './settings.js';
import type { WhisperSettings } from './settings.js';
import { inspectWhisperTokenizer } from './tokenizer.js';
import type { WhisperTokenizer } from './tokenizer.js';
import { wordTimings } from './timestamps.js';
import type { WordTiming } from './timestamps.js';
import {
    DEFAULT_APPEND_PUNCTUATIONS,
    DEFAULT_PREPEND_PUNCTUATIONS,
    splitWords,
    stripWord,
} from './words.js';

export interface AlignmentResult {
    readonly text: string;
    readonly words: readonly WordTiming[];
}

export interface AlignProgress {
    readonly seconds: number;
    readonly totalSeconds: number;
    /**
     * True when the run did not bail out on the failure guard. This is not
     * "the loop reached the end of the audio": a tripped guard reports false.
     */
    readonly finished: boolean;
}

export interface AlignOptions {
    readonly language?: string;
    readonly task?: 'transcribe' | 'translate';
    readonly tokenStep?: number;
    readonly nonspeechSkip?: number | null;
    readonly minSilenceDur?: number | null;
    readonly minWordDur?: number;
    readonly nonspeechError?: number;
    readonly wordDurFactor?: number | null;
    readonly maxWordDur?: number | null;
    /**
     * Split words at spaces (the reference default) instead of at every token
     * piece. Languages without spaces, such as Chinese, need `false`.
     */
    readonly splitWordsBySpace?: boolean;
    /** Window length in samples; defaults to the model window. */
    readonly maxSegmentLength?: number;
    readonly fastMode?: boolean;
    readonly failureThreshold?: number | null;
    readonly onProgress?: (progress: AlignProgress) => void;
    readonly signal?: AbortSignal;
}

interface AlignWord {
    word: string;
    tokens: number[];
    start: number;
    end: number;
    probability: number;
}

interface QueuedWord {
    word: string;
    tokens: number[];
}

interface TempData {
    word: AlignWord | null;
    extraWords: AlignWord[];
    mask: Uint8Array | null;
    offset: number;
}

const DEFAULT_TOKEN_STEP = 100;
const DEFAULT_WORD_DUR_FACTOR = 2.0;
const DEFAULT_MAX_WORD_DUR = 3.0;
const DEFAULT_NONSPEECH_SKIP = 5.0;
const DEFAULT_MIN_WORD_DUR = 0.1;
const DEFAULT_NONSPEECH_ERROR = 0.1;
const TIME_DIGITS = 3;

class WhisperAligner {
    private readonly allPunctuations =
        DEFAULT_PREPEND_PUNCTUATIONS + DEFAULT_APPEND_PUNCTUATIONS;
    private readonly tokenStep: number;
    private readonly wordDurFactor: number | null;
    private readonly maxWordDur: number | null;
    private readonly minWordDur: number;
    private nonspeechSkip: number | null;
    private fastMode: boolean;
    private failureThreshold: number | null;
    private maxFail = 0;

    private seekSample = 0;
    private timeOffset = 0;
    private tempData: TempData = {
        word: null,
        extraWords: [],
        mask: null,
        offset: 0,
    };
    private currWords: AlignWord[] = [];
    private segWordTokens: QueuedWord[] = [];
    private allWordTokens: QueuedWord[] = [];
    private padMask: Uint8Array | null = null;
    private remainingLen = 0;
    private failureCount = 0;

    private readonly handle: ModelHandle;
    private readonly layout: WhisperLayout;
    private readonly settings: WhisperSettings;
    private readonly tokenizer: WhisperTokenizer;
    private readonly audio: PcmAudio;
    private readonly totalSamples: number;
    private readonly nSamples: number;
    private readonly initialDuration: number;
    private readonly tokensPerSec: number;
    private readonly languageId: number;
    private readonly taskId: number;
    private readonly splitBySpace: boolean;
    private readonly nonspeechError: number;
    private readonly minSilenceDur: number | null;
    private readonly onProgress:
        ((progress: AlignProgress) => void) | undefined;
    private readonly signal: AbortSignal | undefined;
    private currentMask: Uint8Array | null = null;
    private currentSpans: readonly SilenceSpan[] = [];
    private readonly allSpans: SilenceSpan[] = [];

    constructor(
        handle: ModelHandle,
        layout: WhisperLayout,
        settings: WhisperSettings,
        tokenizer: WhisperTokenizer,
        audio: PcmAudio,
        frameCount: number,
        options: AlignOptions = {},
    ) {
        this.handle = handle;
        this.layout = layout;
        this.settings = settings;
        this.tokenizer = tokenizer;
        this.audio = audio;
        this.totalSamples = frameCount;
        this.initialDuration = bankersRound(
            frameCount / settings.sampleRate,
            3,
        );
        this.tokensPerSec =
            settings.sampleRate /
            (settings.hopLength * WHISPER_ENCODER_DOWNSAMPLE);
        this.nonspeechError = options.nonspeechError ?? DEFAULT_NONSPEECH_ERROR;
        this.minSilenceDur = options.minSilenceDur ?? null;
        this.splitBySpace = options.splitWordsBySpace ?? true;
        this.onProgress = options.onProgress;
        this.signal = options.signal;

        this.tokenStep = options.tokenStep ?? DEFAULT_TOKEN_STEP;
        this.wordDurFactor = options.wordDurFactor ?? DEFAULT_WORD_DUR_FACTOR;
        this.maxWordDur = options.maxWordDur ?? DEFAULT_MAX_WORD_DUR;
        this.minWordDur = options.minWordDur ?? DEFAULT_MIN_WORD_DUR;
        this.nonspeechSkip = options.nonspeechSkip ?? DEFAULT_NONSPEECH_SKIP;
        this.fastMode = options.fastMode ?? false;
        const failureThreshold = options.failureThreshold ?? null;
        if (
            failureThreshold !== null &&
            (failureThreshold < 0 || failureThreshold > 1)
        ) {
            throw new StemalignError(
                'invalid-option',
                `failureThreshold must be in [0, 1], got ${failureThreshold}`,
            );
        }
        this.failureThreshold = failureThreshold;

        const maxSegmentLength = options.maxSegmentLength ?? settings.nSamples;
        if (!Number.isInteger(maxSegmentLength) || maxSegmentLength <= 0) {
            throw new StemalignError(
                'invalid-option',
                'maxSegmentLength must be a positive whole number of samples',
            );
        }
        if (maxSegmentLength > settings.nSamples) {
            throw new StemalignError(
                'invalid-option',
                `maxSegmentLength must not exceed the model window of ${settings.nSamples} samples`,
            );
        }
        this.nSamples = maxSegmentLength;

        const language = options.language ?? 'en';
        const languageId = settings.languageIds[`<|${language}|>`];
        if (languageId === undefined) {
            throw new StemalignError(
                'missing-setting',
                `the tokenizer settings have no language "${language}"`,
            );
        }
        this.languageId = languageId;
        const task = options.task ?? 'transcribe';
        const taskId = settings.taskIds[task];
        if (taskId === undefined) {
            throw new StemalignError(
                'missing-setting',
                `the tokenizer settings have no task "${task}"`,
            );
        }
        this.taskId = taskId;
    }

    // -- word queue (reference: _get_curr_words) --------------------------

    getCurrWords(): [QueuedWord[], number[], boolean] {
        const all = this.allWordTokens;
        const padMask = this.padMask;
        const padLen = padMask ? padMask.length : 0;
        let currTkCount = 0;
        const wordTokens: QueuedWord[] = [];
        const splitIndices: number[] = [];

        let isStartGap: boolean;
        if (padMask) {
            if (this.remainingLen === padLen) {
                isStartGap = true;
            } else {
                const index = padLen - (this.remainingLen + 1);
                isStartGap =
                    index >= 0 && index < padLen ? padMask[index] === 1 : false;
            }
        } else {
            isStartGap = true;
        }

        while (all.length > 0) {
            const head = all[0];
            const tkCount = head.tokens.length;
            let mCount = 0;
            let padHit = false;
            if (padMask) {
                const index =
                    padLen - (this.remainingLen - head.word.length + 1);
                if (index >= 0 && index < padLen) {
                    padHit = padMask[index] === 1;
                    mCount = padHit ? 1 : 0;
                }
            }
            if (
                currTkCount + splitIndices.length + tkCount + mCount >
                    this.tokenStep &&
                wordTokens.length > 0
            ) {
                break;
            }
            if (padHit) splitIndices.push(wordTokens.length + 1);
            this.remainingLen -= head.word.length;
            wordTokens.push(all.shift() as QueuedWord);
            currTkCount += tkCount;
        }
        return [wordTokens, splitIndices, isStartGap];
    }

    // -- temp word repair (reference: _fix_temp_words) --------------------

    fixTempWords(
        targetWord: AlignWord,
        wordSources: AlignWord[],
        secondTarget: AlignWord | null = null,
    ): [AlignWord | null, AlignWord[]] {
        const firstWordSrc = wordSources[0];
        if (!targetWord.word.startsWith(firstWordSrc.word)) {
            throw new StemalignError(
                'model-invalid',
                `the target word "${targetWord.word}" does not start with "${firstWordSrc.word}"`,
            );
        }

        if (targetWord.word !== firstWordSrc.word) {
            if (wordSources.length < 2) return [null, []];
            const probs = [firstWordSrc.probability];
            const firstStrip = stripWord(firstWordSrc.word);
            if (
                firstStrip.length > 0 &&
                this.allPunctuations.includes(firstStrip)
            ) {
                firstWordSrc.start = wordSources[1].start;
                firstWordSrc.end = wordSources[1].end;
            }
            const loops = wordSources.length - 1;
            for (let n = 0; n < loops; n += 1) {
                const other = wordSources.splice(1, 1)[0];
                const fullword = firstWordSrc.word + other.word;
                if (!targetWord.word.startsWith(fullword)) {
                    throw new StemalignError(
                        'model-invalid',
                        `the target word "${targetWord.word}" does not start with "${fullword}"`,
                    );
                }
                firstWordSrc.word = fullword;
                for (const token of other.tokens)
                    firstWordSrc.tokens.push(token);
                probs.push(other.probability);
                const otherStrip = stripWord(other.word);
                const isPunctuation =
                    otherStrip.length > 0 &&
                    this.allPunctuations.includes(otherStrip);
                if (!isPunctuation) firstWordSrc.end = other.end;
                if (targetWord.word === firstWordSrc.word) break;
            }
            if (targetWord.word !== firstWordSrc.word) return [null, []];
            let sum = 0;
            for (const probability of probs) sum += probability;
            firstWordSrc.probability = sum / probs.length;
        } else if (secondTarget) {
            if (wordSources.length === 1) return [firstWordSrc, []];
            const rest = wordSources.slice(1);
            const [secondWordSrc, restAfter] = this.fixTempWords(
                secondTarget,
                rest,
            );
            if (secondWordSrc !== null) restAfter.unshift(secondWordSrc);
            return [firstWordSrc, restAfter];
        }
        return [firstWordSrc, wordSources.slice(1)];
    }

    // -- requeue (reference: _update_curr_words / _redo_words) ------------

    updateCurrWords(): void {
        if (this.tempData.word === null) return;
        const extras = this.tempData.extraWords;
        const take = Math.max(0, this.currWords.length - 1);
        const tempWords = [this.tempData.word, ...extras.slice(0, take)];
        for (let index = 0; index < tempWords.length; index += 1) {
            this.currWords[index] = tempWords[index];
        }
        this.tempData.word = null;
    }

    redoWords(index: number | null = null): void {
        if (
            index !== null &&
            this.currWords.length > 0 &&
            this.tempData.word !== null
        ) {
            const sources = [this.tempData.word, ...this.tempData.extraWords];
            const secondTarget =
                this.currWords.length > 1 ? this.currWords[1] : null;
            const [fixedWord, fixedExtras] = this.fixTempWords(
                this.currWords[0],
                sources,
                secondTarget,
            );
            this.tempData.word = fixedWord;
            this.tempData.extraWords = fixedExtras;

            if (this.tempData.word) {
                const mask0 = this.currentMask;
                let useNew = this.isNewBetter(
                    this.currWords[0],
                    mask0,
                    this.timeOffset,
                    this.tempData.word,
                    this.tempData.mask,
                    this.tempData.offset,
                );
                const newExtraWords: AlignWord[] = [];
                if (useNew) {
                    this.tempData.word = this.currWords[0];
                } else {
                    const extras = this.tempData.extraWords;
                    const count = Math.min(
                        this.currWords.length - 1,
                        extras.length,
                    );
                    for (let wi = 0; wi < count; wi += 1) {
                        const currentWord = this.currWords[wi + 1];
                        const tempWord = extras[wi];
                        if (!currentWord.word.startsWith(tempWord.word)) {
                            throw new StemalignError(
                                'model-invalid',
                                `the current word "${currentWord.word}" does not start with "${tempWord.word}"`,
                            );
                        }
                        useNew = this.isNewBetter(
                            currentWord,
                            mask0,
                            this.timeOffset,
                            tempWord,
                            this.tempData.mask,
                            this.tempData.offset,
                        );
                        if (
                            useNew ||
                            currentWord.word !== tempWord.word ||
                            currentWord.end < tempWord.end
                        ) {
                            break;
                        }
                        newExtraWords.push(tempWord);
                    }
                }
                this.tempData.extraWords = newExtraWords;
            }
        }

        if (index === null) {
            let add = 0;
            for (const token of this.segWordTokens) add += token.word.length;
            this.remainingLen += add;
            this.allWordTokens = this.segWordTokens.concat(this.allWordTokens);
            this.currWords = [];
            this.tempData.word = null;
        } else if (index !== this.segWordTokens.length) {
            let add = 0;
            for (let k = index; k < this.segWordTokens.length; k += 1) {
                add += this.segWordTokens[k].word.length;
            }
            this.remainingLen += add;
            this.allWordTokens = this.segWordTokens
                .slice(index)
                .concat(this.allWordTokens);

            const newExtraWords = this.currWords.slice(index);
            this.currWords = this.currWords.slice(0, index);

            if (this.currWords.length > 0) {
                this.updateCurrWords();
                this.remainingLen += this.segWordTokens[index - 1].word.length;
                this.allWordTokens = this.segWordTokens
                    .slice(index - 1, index)
                    .concat(this.allWordTokens);
                this.tempData.word = this.currWords.pop() ?? null;
                this.tempData.extraWords = newExtraWords;
                this.tempData.mask = this.currentMask;
                this.tempData.offset = this.timeOffset;
            }
        } else {
            this.updateCurrWords();
        }
    }

    // -- speech voting (reference: _speech_percentage / _is_new_better) ---

    speechPercentage(
        word: AlignWord,
        mask: Uint8Array | null,
        offset: number | null,
    ): number {
        if (mask === null) return 1;
        const start = Math.trunc(
            (word.start - (offset ?? 0)) * this.tokensPerSec,
        );
        const end = Math.trunc((word.end - (offset ?? 0)) * this.tokensPerSec);
        const length = mask.length;
        let first = start < 0 ? 0 : start;
        let last = end < 0 ? 0 : end;
        if (first > length) first = length;
        if (last > length) last = length;
        if (first >= last) return 1;
        let sum = 0;
        for (let index = first; index < last; index += 1) sum += mask[index];
        return 1 - sum / (last - first);
    }

    isNewBetter(
        word0: AlignWord,
        mask0: Uint8Array | null,
        offset0: number | null,
        word1: AlignWord,
        mask1: Uint8Array | null,
        offset1: number | null,
    ): boolean {
        const speech0 = bankersRound(
            this.speechPercentage(word0, mask0, offset0),
            1,
        );
        const speech1 = bankersRound(
            this.speechPercentage(word1, mask1, offset1),
            1,
        );
        return (
            (Math.pow(word1.probability, 0.75) -
                Math.pow(word0.probability, 0.75) <
                0.35 &&
                speech0 >= speech1) ||
            word0.probability >= word1.probability
        );
    }

    // Prefix rows kept by computeAttentionWeights: dropping sot/lang/task leaves
    // <|notimestamps|> as row zero, exactly like find-alignment-stable.mjs:23-24.
    private static readonly PREFIX_LENGTH = 3;

    async run(text: string): Promise<AlignmentResult> {
        const split = splitWords(this.tokenizer, this.tokenizer.encode(text), {
            splitBySpace: this.splitBySpace,
        });
        this.allWordTokens = split.words.map((word, index) => ({
            word,
            tokens: [...split.tokens[index]],
        }));
        this.remainingLen = 0;
        for (const entry of this.allWordTokens)
            this.remainingLen += entry.word.length;
        this.failureCount = 0;
        this.maxFail = this.allWordTokens.length * (this.failureThreshold ?? 1);
        if (this.allWordTokens.length === 0) return { text, words: [] };

        const result: AlignWord[] = [];
        const ranges: Array<readonly [number, number]> = [];
        let lastTs = 0;

        while (this.allWordTokens.length > 0) {
            this.cancel();
            this.timeOffset = this.seekSample / this.settings.sampleRate;
            const raw = this.slice(this.seekSample, this.nSamples);
            if (raw === null) break;

            this.predict(raw);
            const segment = this.skipNonspeech(raw);
            if (segment === null) continue;

            const [wordTokens] = this.getCurrWords();
            this.currWords = await this.windowWords(segment, wordTokens);
            this.segWordTokens = this.currWords.map((word) => ({
                word: word.word,
                tokens: word.tokens.slice(),
            }));

            lastTs = this.fallback(checkPcmAudio(segment).frameCount);
            this.report(lastTs, false);

            const first = result.length;
            for (const word of this.currWords) result.push(word);
            ranges.push([first, result.length]);

            if (this.failureThreshold !== null) {
                for (const word of this.currWords) {
                    if (word.end - word.start === 0) this.failureCount += 1;
                }
                if (this.failureCount > this.maxFail) break;
            }
        }

        this.report(lastTs, this.failureCount <= this.maxFail);
        if (this.tempData.word !== null) result.push(this.tempData.word);

        // Whatever is still queued never got a timestamp. The reference appends
        // those words at the end of the audio (removeInstantWords = false); we
        // drop them and let the caller decide, per the alignment contract.

        let words: readonly AlignWord[] = this.clampWindows(result, ranges);
        const silences = mergeSilences(this.allSpans);
        words = words.map((word) => {
            const span = suppressSilence(word, silences, {
                minWordDur: this.minWordDur,
                nonspeechError: this.nonspeechError,
                keepEnd: true,
            });
            return { ...word, start: span.start, end: span.end };
        });
        return { text, words };
    }

    private clampWindows(
        result: readonly AlignWord[],
        ranges: readonly (readonly [number, number])[],
    ): readonly AlignWord[] {
        let words: readonly AlignWord[] = result;
        for (let index = 0; index < ranges.length; index += 1) {
            const [first, last] = ranges[index];
            const clamped = clampWords(words.slice(first, last)).map(
                (word) => ({
                    ...word,
                    tokens: [...word.tokens],
                }),
            );
            words = words.slice(0, first).concat(clamped, words.slice(last));
        }
        return words;
    }

    private async windowWords(
        segment: PcmAudio,
        wordTokens: readonly QueuedWord[],
    ): Promise<AlignWord[]> {
        const tokenIds: number[] = [
            this.settings.decoderStartTokenId,
            this.languageId,
            this.taskId,
            this.settings.noTimestampsTokenId,
        ];
        for (const entry of wordTokens)
            for (const id of entry.tokens) tokenIds.push(id);
        tokenIds.push(this.settings.eosTokenId);

        const mel = melSpectrogram(segment, this.settings);
        const hidden = await runEncoder(
            this.handle,
            this.layout,
            this.settings,
            mel,
        );
        const pass = await runDecoder(this.handle, this.layout, this.settings, {
            hiddenStates: hidden,
            tokenIds,
        });
        const samples = checkPcmAudio(segment).frameCount;
        const attention = computeAttentionWeights(pass, this.settings, {
            sotLen: WhisperAligner.PREFIX_LENGTH,
            numSamples: samples,
        });
        const jumps = computeJumpIndices(attention);
        const split = {
            words: wordTokens.map((entry) => entry.word),
            tokens: wordTokens.map((entry) => entry.tokens),
        };
        // The decoder reports one probability per emitted token, so the text
        // tokens of this window start at PREFIX_LENGTH: the row that followed
        // <|notimestamps|> (see emittedTokenProbabilities in decoder.ts). The
        // reference averages these per word in findAlignmentStable
        // (reference/whisper/src/find-alignment-stable.mjs:159).
        const probabilities = pass.probabilities.subarray(
            WhisperAligner.PREFIX_LENGTH,
            WhisperAligner.PREFIX_LENGTH +
                split.tokens.reduce((sum, group) => sum + group.length, 0),
        );
        const timings = wordTimings(split, jumps, this.settings, {
            probabilities,
        });
        // computeTimestamps clamps against the window end before adding the
        // window offset, then rounds to milliseconds.
        const maxCurrTs = bankersRound(samples / this.settings.sampleRate, 4);
        return timings.map((timing) => ({
            word: timing.word,
            tokens: [...timing.tokens],
            start: bankersRound(
                Math.min(timing.start, maxCurrTs) + this.timeOffset,
                TIME_DIGITS,
            ),
            end: bankersRound(
                Math.min(timing.end, maxCurrTs) + this.timeOffset,
                TIME_DIGITS,
            ),
            probability: timing.probability,
        }));
    }

    private predict(audio: PcmAudio): void {
        const mask = silenceMask(audio);
        this.currentMask = mask;
        let spans = maskSpans(
            mask,
            SILENCE_UNIT_SAMPLES / this.settings.sampleRate,
            this.timeOffset,
        );
        if (this.minSilenceDur !== null)
            spans = filterSilences(spans, this.minSilenceDur);
        this.currentSpans = spans;
        for (const span of spans) this.allSpans.push(span);
    }

    private skipNonspeech(audio: PcmAudio): PcmAudio | null {
        if (this.nonspeechSkip === null) return audio;
        const spans = this.currentSpans;
        if (spans.length === 0) return audio;

        const segmentSamples = checkPcmAudio(audio).frameCount;
        const segmentDuration = segmentSamples / this.settings.sampleRate;
        const maxTimeOffset = this.timeOffset + this.minWordDur;
        const minTimeOffset = this.timeOffset - this.minWordDur;

        if (
            spans[0].start < maxTimeOffset &&
            spans[0].end > minTimeOffset + segmentDuration
        ) {
            this.seekSample += segmentSamples;
            return null;
        }

        const valid = spans.filter(
            (span) => span.end - span.start >= (this.nonspeechSkip as number),
        );
        if (valid.length === 0) return audio;
        if (maxTimeOffset < valid[0].start) return audio;

        this.seekSample = Math.trunc(
            bankersRound(valid[0].end * this.settings.sampleRate, 0),
        );
        if (
            this.seekSample + this.minWordDur * this.settings.sampleRate >
            this.totalSamples
        ) {
            this.seekSample = this.totalSamples;
            return null;
        }
        this.timeOffset = this.seekSample / this.settings.sampleRate;

        let segment = this.slice(this.seekSample, this.nSamples);
        if (segment === null) return null;
        this.predict(segment);

        if (valid.length > 1) {
            const newSampleCount = Math.trunc(
                bankersRound(
                    (valid[1].start - valid[0].end) * this.settings.sampleRate,
                    0,
                ),
            );
            const frames = checkPcmAudio(segment).frameCount;
            if (newSampleCount < frames) {
                segment = {
                    sampleRate: segment.sampleRate,
                    channels: [segment.channels[0].subarray(0, newSampleCount)],
                };
            }
        }
        return segment;
    }

    private fallback(segmentSamples: number): number {
        const words = this.currWords;
        const count = words.length;
        const durations = new Float64Array(count);
        for (let index = 0; index < count; index += 1) {
            durations[index] = bankersRound(
                words[index].end - words[index].start,
                TIME_DIGITS,
            );
        }
        const nonzero: number[] = [];
        for (let index = 0; index < count; index += 1)
            if (durations[index] > 0) nonzero.push(index);

        let lastTs: number;

        if (nonzero.length > 0) {
            let redoIndex = nonzero[nonzero.length - 1] + 1;
            if (
                this.allWordTokens.length > 0 &&
                nonzero.length > 1 &&
                words[nonzero[nonzero.length - 1]].end >=
                    Math.floor(
                        this.timeOffset +
                            segmentSamples / this.settings.sampleRate,
                    )
            ) {
                nonzero.pop();
                redoIndex = nonzero[nonzero.length - 1] + 1;
            }

            let medDur = median(durations.subarray(0, redoIndex));
            let globalMaxDur: number | null = null;
            let newStart: number | null = null;

            if (!this.fastMode) {
                let localMaxDur = this.wordDurFactor
                    ? bankersRound(medDur * this.wordDurFactor, TIME_DIGITS)
                    : null;
                if (this.maxWordDur) {
                    localMaxDur =
                        localMaxDur !== null
                            ? Math.min(localMaxDur, this.maxWordDur)
                            : this.maxWordDur;
                    globalMaxDur = this.maxWordDur;
                } else {
                    globalMaxDur = localMaxDur || null;
                }
                if (globalMaxDur && medDur > globalMaxDur)
                    medDur = globalMaxDur;

                const cap = globalMaxDur;
                if (
                    localMaxDur &&
                    cap !== null &&
                    durations[nonzero[0]] > cap
                ) {
                    const first = words[nonzero[0]];
                    const raw = first.end - (medDur * nonzero[0] + localMaxDur);
                    newStart = bankersRound(
                        Math.max(raw, first.start),
                        TIME_DIGITS,
                    );
                    if (newStart <= this.timeOffset) newStart = null;
                }
            }

            if (newStart === null) {
                const cap = globalMaxDur;
                if (cap) {
                    const indexOffset = nonzero[0] + 1;
                    let firstRedo = -1;
                    for (let k = indexOffset; k < redoIndex; k += 1) {
                        if (durations[k] > cap) {
                            firstRedo = k;
                            break;
                        }
                    }
                    if (firstRedo >= 0) redoIndex = firstRedo;
                }
                lastTs = words[redoIndex - 1].end;
                this.redoWords(redoIndex);
            } else {
                lastTs = newStart;
                this.redoWords();
            }
            this.seekSample = Math.trunc(
                bankersRound(lastTs * this.settings.sampleRate, 0),
            );
        } else {
            this.seekSample += segmentSamples;
            lastTs = bankersRound(
                this.seekSample / this.settings.sampleRate,
                2,
            );
            this.redoWords();
        }

        return lastTs;
    }

    private slice(start: number, capacity: number): PcmAudio | null {
        const channel = this.audio.channels[0];
        if (start >= channel.length) return null;
        const end = Math.min(channel.length, start + capacity);
        return {
            sampleRate: this.audio.sampleRate,
            channels: [channel.subarray(start, end)],
        };
    }

    private report(seconds: number, finished: boolean): void {
        if (this.onProgress === undefined) return;
        this.onProgress({
            seconds,
            totalSeconds: this.initialDuration,
            finished,
        });
    }

    private cancel(): void {
        if (this.signal?.aborted === true) {
            throw new StemalignError('cancelled', 'the alignment was aborted');
        }
    }
}

/** Sorted-copy median, i.e. numpy.median (reference aligner.mjs:1157). */
function median(values: Float64Array): number {
    const sorted = Float64Array.from(values);
    sorted.sort();
    const count = sorted.length;
    if (count === 0) return Number.NaN;
    if (count % 2 === 1) return sorted[(count - 1) >> 1];
    const middle = count >> 1;
    return 0.5 * (sorted[middle - 1] + sorted[middle]);
}

export async function align(
    audio: PcmAudio,
    text: string,
    handle: ModelHandle,
    options: AlignOptions = {},
): Promise<AlignmentResult> {
    const layout = inspectWhisper(handle);
    const settings = inspectWhisperSettings(handle, layout);
    const tokenizer = inspectWhisperTokenizer(handle, settings);
    const info = checkPcmAudio(audio);
    const rateAdjusted =
        info.sampleRate === settings.sampleRate
            ? audio
            : resample(audio, settings.sampleRate);
    const mono = toChannelCount(rateAdjusted, 1);
    const frameCount = checkPcmAudio(mono).frameCount;
    const aligner = new WhisperAligner(
        handle,
        layout,
        settings,
        tokenizer,
        mono,
        frameCount,
        options,
    );
    return aligner.run(text);
}
