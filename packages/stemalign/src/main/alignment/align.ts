import { checkPcmAudio } from '../audio/check.js';
import { toChannelCount } from '../audio/channels.js';
import { resample } from '../audio/resample.js';
import type { PcmAudio } from '../audio/types.js';
import { StemalignError } from '../errors.js';
import type { ModelHandle } from '../model/session.js';
import { bankersRound } from '../round.js';
import { computeAttentionWeights } from './attention.js';
import { clampWords, DEFAULT_CLAMP_OPTIONS } from './clamp.js';
import type { ClampOptions } from './clamp.js';
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
import { DEFAULT_REGROUP_ALGO, regroupSegments } from './regroup.js';
import type { RegroupResult } from './regroup.js';
import { makeSegment, suppressSegmentSilence } from './segment.js';
import type { AlignmentSegment } from './segment.js';
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

/** A non-speech section of the audio, like stable_ts `nonspeech_sections`. */
export interface AlignmentSilence {
    readonly start: number;
    readonly end: number;
}

/**
 * The snapshot stable_ts keeps in `ori_dict`: the segments as they looked after
 * suppression and before regrouping.
 */
export interface AlignmentOriginal {
    readonly text: string;
    readonly segments: readonly AlignmentSegment[];
    readonly language: string;
    readonly ori_dict: Readonly<Record<string, never>>;
    readonly regroup_history: string;
    readonly nonspeech_sections: readonly AlignmentSilence[];
}

/**
 * The alignment result, mirroring `stable_whisper.WhisperResult.to_dict()`.
 * `text` is the concatenation of the surviving segments, not the input text:
 * words that never got a timestamp are dropped (see `align()`).
 */
export interface AlignmentResult {
    readonly text: string;
    readonly segments: readonly AlignmentSegment[];
    readonly language: string;
    readonly ori_dict: AlignmentOriginal;
    readonly regroup_history: string;
    readonly nonspeech_sections: readonly AlignmentSilence[];
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
    /**
     * Suppress the words that land inside a detected silence (default true, the
     * stable_ts `suppress_silence` switch).
     */
    readonly suppressSilence?: boolean;
    /**
     * Suppress every word instead of only the edge words of a segment (default true,
     * the stable_ts `suppress_word_ts` switch).
     */
    readonly suppressWordTimestamps?: boolean;
    /**
     * Let the trailing punctuation and the word position decide which edge is kept
     * (default true, the stable_ts `use_word_position` switch).
     */
    readonly useWordPosition?: boolean;
    /**
     * Regroup the suppressed words into sentences with the stable_ts algorithm
     * (default `da`). `false` keeps the flat segment; any other string is parsed
     * by `regroupSegments` and unknown calls are rejected.
     */
    readonly regroup?: boolean | string;
    readonly wordDurFactor?: number | null;
    readonly maxWordDur?: number | null;
    /**
     * Post-alignment duration clamp applied to the words of one window, the
     * `WhisperResult.clamp_max` step of stable_ts. Defaults to that method's
     * defaults (2.5 times the window median, only the first word at its start
     * and the last word at its end). `false` skips the per-window pass, but
     * `regroup` runs its own clamp over the segments it rebuilds, so a caller
     * that needs untouched durations must turn regrouping off as well. Note
     * that `wordDurFactor` and `maxWordDur` are the aligner's redo heuristic,
     * not this clamp.
     */
    readonly clamp?: ClampOptions | false;
    /**
     * Split words at spaces (the reference default) instead of at every token
     * piece. Languages without spaces, such as Chinese, need `false`.
     */
    readonly splitWordsBySpace?: boolean;
    /** Window length in samples, at least one second; defaults to the model window. */
    readonly maxSegmentLength?: number;
    readonly fastMode?: boolean;
    /**
     * Fraction of words that may come back with zero duration before the run
     * bails out. One or more disables the check, as does the default.
     */
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
    private readonly clamp: ClampOptions | false;
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
    private readonly languageName: string;
    private readonly taskId: number;
    private readonly splitBySpace: boolean;
    private readonly nonspeechError: number;
    private readonly suppressSilence: boolean;
    private readonly suppressWordTimestamps: boolean;
    private readonly useWordPosition: boolean;
    private readonly regroupAlgo: false | string;
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
        this.suppressSilence = options.suppressSilence ?? true;
        this.suppressWordTimestamps = options.suppressWordTimestamps ?? true;
        this.useWordPosition = options.useWordPosition ?? true;
        this.regroupAlgo =
            options.regroup === undefined || options.regroup === true
                ? DEFAULT_REGROUP_ALGO
                : options.regroup;
        this.minSilenceDur = options.minSilenceDur ?? null;
        this.splitBySpace = options.splitWordsBySpace ?? true;
        this.onProgress = options.onProgress;
        this.signal = options.signal;

        this.tokenStep = options.tokenStep ?? DEFAULT_TOKEN_STEP;
        this.wordDurFactor = options.wordDurFactor ?? DEFAULT_WORD_DUR_FACTOR;
        this.maxWordDur = options.maxWordDur ?? DEFAULT_MAX_WORD_DUR;
        this.clamp =
            options.clamp === undefined ? DEFAULT_CLAMP_OPTIONS : options.clamp;
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
        // A window shorter than a second leaves the DTW with fewer frames than
        // the window can carry tokens, so words collapse to zero duration.
        if (maxSegmentLength < settings.sampleRate) {
            throw new StemalignError(
                'invalid-option',
                `maxSegmentLength must be at least one second (${String(settings.sampleRate)} samples), got ${String(maxSegmentLength)}`,
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
        this.languageName = language;
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

    getCurrWords(): QueuedWord[] {
        const all = this.allWordTokens;
        let currTkCount = 0;
        const wordTokens: QueuedWord[] = [];

        while (all.length > 0) {
            const head = all[0];
            const tkCount = head.tokens.length;
            if (
                currTkCount + tkCount > this.tokenStep &&
                wordTokens.length > 0
            ) {
                break;
            }
            wordTokens.push(all.shift() as QueuedWord);
            currTkCount += tkCount;
        }
        return wordTokens;
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
            this.allWordTokens = this.segWordTokens.concat(this.allWordTokens);
            this.currWords = [];
            this.tempData.word = null;
        } else if (index !== this.segWordTokens.length) {
            this.allWordTokens = this.segWordTokens
                .slice(index)
                .concat(this.allWordTokens);

            const newExtraWords = this.currWords.slice(index);
            this.currWords = this.currWords.slice(0, index);

            if (this.currWords.length > 0) {
                this.updateCurrWords();
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
        this.failureCount = 0;
        this.maxFail = this.allWordTokens.length * (this.failureThreshold ?? 1);
        if (this.allWordTokens.length === 0) {
            return this.composeResult([], [], { segments: [], history: '' });
        }

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

            const wordTokens = this.getCurrWords();
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

        // Whatever is still queued never got a timestamp. The reference appends
        // those words at the end of the audio (removeInstantWords = false); we
        // drop them and let the caller decide, per the alignment contract.

        // `tempData.word` is appended after the loop recorded the range of the
        // window that rescued it, so it is folded into that last range here: it
        // must go through the same per-window clamp as the words before it.
        const words = clampWindowWords(
            result,
            ranges,
            this.tempData.word,
            this.clamp,
        );
        // stable_ts records the non-speech sections only while suppressing
        // (aligner.mjs:888 leaves `_nonspeech_sections` empty otherwise).
        const silences = this.suppressSilence
            ? mergeSilences(this.allSpans)
            : [];

        // stable_ts aligns one flat segment per run and suppresses at the segment level
        // (aligner.mjs:1062-1075); regroup runs afterwards, on the suppressed words.
        const built = makeSegment(words);
        const originalSegments = (
            this.suppressSilence
                ? [
                      suppressSegmentSilence(built, silences, {
                          minWordDur: this.minWordDur,
                          nonspeechError: this.nonspeechError,
                          wordLevel: this.suppressWordTimestamps,
                          useWordPosition: this.useWordPosition,
                      }),
                  ]
                : [built]
        ).filter((segment) => segment.words.length > 0);

        const regrouped: RegroupResult =
            this.regroupAlgo === false
                ? { segments: originalSegments, history: '' }
                : regroupSegments(originalSegments, { algo: this.regroupAlgo });
        return this.composeResult(originalSegments, silences, regrouped);
    }

    /**
     * Compose the `WhisperResult.to_dict()` shape: `ori_dict` is the snapshot
     * stable_ts takes after suppression and before regrouping.
     */
    private composeResult(
        originalSegments: readonly AlignmentSegment[],
        silences: readonly SilenceSpan[],
        regrouped: RegroupResult,
    ): AlignmentResult {
        const segments = regrouped.segments.filter(
            (segment) => segment.words.length > 0,
        );
        const nonspeech_sections = silences.map((span) => ({
            start: bankersRound(span.start, TIME_DIGITS),
            end: bankersRound(span.end, TIME_DIGITS),
        }));
        return {
            text: segments.map((segment) => segment.text).join(''),
            segments,
            language: this.languageName,
            ori_dict: {
                text: originalSegments.map((segment) => segment.text).join(''),
                segments: originalSegments,
                language: this.languageName,
                ori_dict: {},
                regroup_history: '',
                nonspeech_sections,
            },
            regroup_history: regrouped.history,
            nonspeech_sections,
        };
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

/**
 * Apply the per-window clamp to the words the window loop collected, after
 * folding in the trailing word the last window rescued (`tempData.word`). That
 * word is appended once the loop has recorded the range of the window that
 * produced it, so it joins that last range here: otherwise it would sit outside
 * every range and keep a duration the rest of the window never gets to keep.
 *
 * Exported for the align tests: `index.ts` does not re-export it, so the
 * package API is unchanged.
 */
export function clampWindowWords(
    words: readonly WordTiming[],
    ranges: readonly (readonly [number, number])[],
    trailing: WordTiming | null,
    options: ClampOptions | false,
): readonly WordTiming[] {
    const all = trailing === null ? words : [...words, trailing];
    if (options === false) return all;
    let clamped: readonly WordTiming[] = all;
    const windows =
        trailing === null ? ranges : widenLastRange(ranges, all.length);
    for (const [first, last] of windows) {
        const window = clampWords(clamped.slice(first, last), options).map(
            (word) => ({ ...word, tokens: [...word.tokens] }),
        );
        clamped = clamped.slice(0, first).concat(window, clamped.slice(last));
    }
    return clamped;
}

// The trailing word belongs to the window that produced the last range, so that
// range grows to include it. A run that recorded no range at all still clamps
// the trailing word, in a range of its own.
function widenLastRange(
    ranges: readonly (readonly [number, number])[],
    end: number,
): readonly (readonly [number, number])[] {
    const last = ranges[ranges.length - 1];
    const widened: readonly [number, number] = [
        last === undefined ? end - 1 : last[0],
        end,
    ];
    if (last === undefined) return [widened];
    return [...ranges.slice(0, -1), widened];
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
