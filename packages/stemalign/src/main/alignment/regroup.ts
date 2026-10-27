import { StemalignError } from '../errors.js';
import { clampWords } from './clamp.js';
import type { AlignmentSegment, SegmentMeta } from './segment.js';
import { makeSegment } from './segment.js';
import type { WordTiming } from './timestamps.js';

// Port of stable_whisper.result.WhisperResult.regroup (result.py:2887-2972) for the
// default algorithm 'da' (result.py:2924):
//
//     isp_cm_sp=.* /。/?/？_sg=.5_sp=,* /，++++50_sl=70_cm
//
// i.e. ignore periods that probably are not sentence ends, clamp long words, split
// after sentence punctuation, split on gaps of half a second, split after commas in
// segments of at least 50 characters, split segments over 70 characters, clamp again.
//
// stable-ts models word locks and several of its methods only exist to move them
// around; this port does not model locks, so the methods of the default algorithm are
// the only ones it implements and a lock request is rejected instead of ignored.
export const DEFAULT_REGROUP_ALGO = 'da';

const DA_CALLS = 'isp_cm_sp=.* /。/?/？_sg=.5_sp=,* /，++++50_sl=70_cm'.split(
    '_',
);

// Default of WhisperResult.clamp_max (result.py:2018).
const DEFAULT_MEDIUM_FACTOR = 2.5;

// Leading parameter names of the implemented methods, mirroring
// `method.__code__.co_varnames[1:]` in Python, so positional arguments can bind to
// them (result.py:2974-3064 lists the methods and their parameters).
const METHOD_PARAMS: Readonly<Record<string, readonly string[]>> = {
    isp: ['enable'],
    cm: ['medium_factor', 'max_dur', 'clip_start', 'verbose'],
    sg: ['max_gap', 'lock', 'newline', 'ignore_special_periods'],
    sp: [
        'punctuation',
        'lock',
        'newline',
        'min_words',
        'min_chars',
        'min_dur',
        'ignore_special_periods',
    ],
    sl: [
        'max_chars',
        'max_words',
        'even_split',
        'force_len',
        'lock',
        'include_lock',
        'newline',
        'ignore_special_periods',
    ],
};

// Method keys stable-ts defines (result.py:2913-2934) that this port leaves out.
const OTHER_METHODS = [
    'sd',
    'mg',
    'mp',
    'ms',
    'l',
    'us',
    'rw',
    'rs',
    'rp',
    'rws',
    'fg',
    'p',
    'ag',
    'csl',
    'co',
];

export type RegroupPunctuation = string | readonly string[];

export type RegroupValue =
    null | string | number | readonly RegroupPunctuation[];

export interface RegroupCall {
    readonly method: string;
    readonly kwargs: Readonly<Record<string, RegroupValue>>;
}

export interface RegroupOptions {
    readonly algo?: string;
}

export interface RegroupResult {
    readonly segments: readonly AlignmentSegment[];
    readonly history: string;
}

// Port of stable_whisper.utils.str_to_valid_type: an empty argument is a missing one,
// `/` builds a list of strings, `*` nests an item into a list of strings, digits are
// numbers and everything else stays a string.
function toValidType(text: string): RegroupValue {
    if (text === '') return null;
    if (text.includes('/')) {
        return text
            .split('/')
            .map((part) => (part.includes('*') ? part.split('*') : part));
    }
    if (text.trim() !== '' && !Number.isNaN(Number(text))) {
        if (text.includes('.')) return Number(text);
        if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
    }
    return text;
}

// Port of WhisperResult.parse_regroup_algo. `da` expands in place, `=` separates the
// method from its arguments, `+` separates arguments (empty ones are skipped).
export function parseRegroupAlgo(algo: string): readonly RegroupCall[] {
    if (algo === '') {
        throw new StemalignError(
            'invalid-option',
            'the regroup algorithm must not be empty',
            { expected: 'an algorithm string', actual: 'an empty string' },
        );
    }

    let calls = algo.split('_');
    if (calls.includes('da')) {
        const expanded: string[] = [];
        for (const call of calls) {
            if (call === 'da') {
                for (const expandedCall of DA_CALLS)
                    expanded.push(expandedCall);
            } else {
                expanded.push(call);
            }
        }
        calls = expanded;
    }

    const parsed: RegroupCall[] = [];
    for (const call of calls) {
        const separator = call.indexOf('=');
        const method = separator < 0 ? call : call.slice(0, separator);
        const argumentsText = separator < 0 ? '' : call.slice(separator + 1);
        if (!(method in METHOD_PARAMS)) {
            if (OTHER_METHODS.includes(method)) {
                throw new StemalignError(
                    'invalid-option',
                    `regroup: the method "${method}" is not implemented`,
                    {
                        expected: 'isp, cm, sg, sp or sl',
                        actual: method,
                    },
                );
            }
            throw new StemalignError(
                'invalid-option',
                `regroup: unknown method "${method}"`,
                { expected: 'a regroup method', actual: method },
            );
        }
        const values =
            argumentsText === ''
                ? []
                : argumentsText.split('+').map((value) => toValidType(value));
        const names = METHOD_PARAMS[method];
        const kwargs: Record<string, RegroupValue> = {};
        for (let index = 0; index < names.length; index++) {
            const value = values[index];
            if (value !== undefined && value !== null) {
                kwargs[names[index]] = value;
            }
        }
        parsed.push({ method, kwargs });
    }
    return parsed;
}

interface RegroupState {
    segments: AlignmentSegment[];
    ignoreSpecialPeriods: boolean;
    history: string;
}

// Port of WhisperResult._update_history (result.py:1527-1532).
function updateHistory(state: RegroupState, changes: string): void {
    if (changes === '') return;
    if (state.history !== '') state.history += '_';
    state.history += changes;
}

function describeValue(value: RegroupValue | undefined): string {
    return value === undefined ? 'nothing' : JSON.stringify(value);
}

function readNumber(
    kwargs: Readonly<Record<string, RegroupValue>>,
    name: string,
): number | null {
    const value = kwargs[name];
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new StemalignError(
            'invalid-option',
            `regroup: ${name} must be a number`,
            { expected: 'a number', actual: describeValue(value) },
        );
    }
    return value;
}

function readBoolean(
    kwargs: Readonly<Record<string, RegroupValue>>,
    name: string,
    fallback: boolean,
): boolean {
    const value = kwargs[name];
    if (value === undefined) return fallback;
    if (typeof value === 'number') return value !== 0;
    if (value === 'True' || value === 'true') return true;
    if (value === 'False' || value === 'false') return false;
    throw new StemalignError(
        'invalid-option',
        `regroup: ${name} must be a flag`,
        {
            expected: 'a flag',
            actual: describeValue(value),
        },
    );
}

function readPunctuation(
    kwargs: Readonly<Record<string, RegroupValue>>,
    name: string,
): readonly RegroupPunctuation[] {
    const value = kwargs[name];
    if (typeof value === 'string') {
        return [value];
    }
    if (!Array.isArray(value)) {
        throw new StemalignError(
            'invalid-option',
            `regroup: ${name} must be a punctuation list`,
            { expected: 'a punctuation list', actual: describeValue(value) },
        );
    }
    const punctuation: RegroupPunctuation[] = [];
    for (const item of value as readonly RegroupPunctuation[]) {
        if (typeof item === 'string') {
            punctuation.push(item);
        } else if (Array.isArray(item) && item.length === 2) {
            punctuation.push(item.map((part) => String(part)));
        } else {
            throw new StemalignError(
                'invalid-option',
                `regroup: ${name} pairs a leading and a trailing string`,
                { expected: 'a pair of strings', actual: JSON.stringify(item) },
            );
        }
    }
    return punctuation;
}

function metaOf(segment: AlignmentSegment): Partial<SegmentMeta> {
    return {
        seek: segment.seek,
        temperature: segment.temperature,
        avg_logprob: segment.avg_logprob,
        compression_ratio: segment.compression_ratio,
        no_speech_prob: segment.no_speech_prob,
    };
}

function codePointLength(text: string): number {
    return [...text].length;
}

function sortedUnique(values: readonly number[]): number[] {
    return Array.from(new Set(values)).sort((left, right) => left - right);
}

// Port of WhisperResult.parse_regroup_algo's call site: every method runs in order.
export function regroupSegments(
    segments: readonly AlignmentSegment[],
    options: RegroupOptions = {},
): RegroupResult {
    const algo = options.algo ?? DEFAULT_REGROUP_ALGO;
    const state: RegroupState = {
        segments: segments.slice(),
        ignoreSpecialPeriods: false,
        history: '',
    };
    for (const call of parseRegroupAlgo(algo)) {
        applyCall(state, call);
    }
    return { segments: state.segments, history: state.history };
}

function applyCall(state: RegroupState, call: RegroupCall): void {
    switch (call.method) {
        case 'isp':
            return opIgnoreSpecialPeriods(state, call.kwargs);
        case 'cm':
            return opClampMax(state, call.kwargs);
        case 'sg':
            return opSplitByGap(state, call.kwargs);
        case 'sp':
            return opSplitByPunctuation(state, call.kwargs);
        case 'sl':
            return opSplitByLength(state, call.kwargs);
        default:
            throw new StemalignError(
                'invalid-option',
                `regroup: the method "${call.method}" is not implemented`,
                { expected: 'isp, cm, sg, sp or sl', actual: call.method },
            );
    }
}

// Port of WhisperResult.ignore_special_periods (result.py:1596-1598).
function opIgnoreSpecialPeriods(
    state: RegroupState,
    kwargs: Readonly<Record<string, RegroupValue>>,
): void {
    const enable = readBoolean(kwargs, 'enable', true);
    state.ignoreSpecialPeriods = enable;
    updateHistory(state, `isp=${enable ? 1 : 0}`);
}

// Port of WhisperResult.clamp_max (result.py:2016-2074).
function opClampMax(
    state: RegroupState,
    kwargs: Readonly<Record<string, RegroupValue>>,
): void {
    const mediumFactor = readNumber(kwargs, 'medium_factor');
    const maxDur = readNumber(kwargs, 'max_dur');
    const clipStart = kwargs['clip_start'];
    const factor = mediumFactor === null ? DEFAULT_MEDIUM_FACTOR : mediumFactor;
    if (typeof clipStart !== 'undefined' && typeof clipStart !== 'boolean') {
        throw new StemalignError(
            'invalid-option',
            'regroup: clip_start must be a flag',
            { expected: 'a flag', actual: describeValue(clipStart) },
        );
    }
    if (!factor && !maxDur) {
        throw new StemalignError(
            'invalid-option',
            'clamping needs a medium factor or a maximum duration',
            {
                expected: 'a medium factor or a maximum duration',
                actual: 'neither',
            },
        );
    }

    const maxDuration = maxDur === null ? false : maxDur;
    state.segments = state.segments.map((segment) => {
        const words =
            typeof clipStart === 'boolean'
                ? clampWords(segment.words, {
                      mediumFactor: factor,
                      maxDur: maxDuration,
                      clipStart,
                  })
                : clampWords(segment.words, {
                      mediumFactor: factor,
                      maxDur: maxDuration,
                  });
        return words === segment.words
            ? segment
            : makeSegment(words, metaOf(segment));
    });
    updateHistory(
        state,
        `cm=${factor}+${maxDur ? maxDur : ''}+${clipStart ? 'True' : ''}+0`,
    );
}

// Port of WhisperResult.split_by_gap (result.py:1600-1634).
function opSplitByGap(
    state: RegroupState,
    kwargs: Readonly<Record<string, RegroupValue>>,
): void {
    const maxGap = readNumber(kwargs, 'max_gap') ?? 0.1;
    const lock = readBoolean(kwargs, 'lock', false);
    const newline = readBoolean(kwargs, 'newline', false);
    const ignoreSpecial =
        state.ignoreSpecialPeriods ||
        readBoolean(kwargs, 'ignore_special_periods', false);
    splitSegments(state, (segment) => gapIndices(segment, maxGap), {
        lock,
        newline,
        ignoreSpecial,
    });
    updateHistory(
        state,
        `sg=${maxGap}+${lock ? 1 : 0}+${newline ? 1 : 0}+${ignoreSpecial ? 1 : 0}`,
    );
}

// Port of WhisperResult.split_by_punctuation (result.py:1683-1742).
function opSplitByPunctuation(
    state: RegroupState,
    kwargs: Readonly<Record<string, RegroupValue>>,
): void {
    const punctuation = readPunctuation(kwargs, 'punctuation');
    const lock = readBoolean(kwargs, 'lock', false);
    const newline = readBoolean(kwargs, 'newline', false);
    const minWords = readNumber(kwargs, 'min_words');
    const minChars = readNumber(kwargs, 'min_chars');
    const minDur = readNumber(kwargs, 'min_dur');
    const ignoreSpecial =
        state.ignoreSpecialPeriods ||
        readBoolean(kwargs, 'ignore_special_periods', false);
    const filtered = [minWords, minChars, minDur].some((value) =>
        Boolean(value),
    );

    // Python keys the filter on `Segment.id`, which is the position of the segment
    // (result.py:1725): the splitter walks the list backwards, so positions hold.
    const overMax = new Set<number>();
    if (filtered) {
        state.segments.forEach((segment, index) => {
            if (overMaxLength(segment, minWords, minChars, minDur)) {
                overMax.add(index);
            }
        });
    }

    splitSegments(
        state,
        (segment, index) =>
            filtered && !overMax.has(index)
                ? []
                : punctuationIndices(segment, punctuation),
        { lock, newline, ignoreSpecial },
    );

    const punctuationText = punctuation
        .map((pattern) =>
            typeof pattern === 'string' ? pattern : pattern.join('*'),
        )
        .join('/');
    updateHistory(
        state,
        `sp=${punctuationText}+${lock ? 1 : 0}+${newline ? 1 : 0}+${
            minWords ?? ''
        }+${minChars ?? ''}+${minDur ?? ''}+${ignoreSpecial ? 1 : 0}`,
    );
}

// Port of WhisperResult.split_by_length (result.py:1890-1953).
function opSplitByLength(
    state: RegroupState,
    kwargs: Readonly<Record<string, RegroupValue>>,
): void {
    const maxChars = readNumber(kwargs, 'max_chars');
    const maxWords = readNumber(kwargs, 'max_words');
    const evenSplit = readBoolean(kwargs, 'even_split', true);
    const forceLen = readBoolean(kwargs, 'force_len', false);
    const lock = readBoolean(kwargs, 'lock', false);
    const includeLock = readBoolean(kwargs, 'include_lock', false);
    const newline = readBoolean(kwargs, 'newline', false);
    const ignoreSpecial =
        state.ignoreSpecialPeriods ||
        readBoolean(kwargs, 'ignore_special_periods', false);
    if (forceLen) {
        throw new StemalignError(
            'invalid-option',
            'regroup: force_len needs merge_all_segments, which is not implemented',
            { expected: 'force_len false', actual: 'force_len true' },
        );
    }

    splitSegments(
        state,
        (segment) => lengthIndices(segment, { maxChars, maxWords, evenSplit }),
        { lock, newline, ignoreSpecial },
    );
    updateHistory(
        state,
        `sl=${maxChars ?? ''}+${maxWords ?? ''}+${evenSplit ? 1 : 0}+${
            forceLen ? 1 : 0
        }+${lock ? 1 : 0}+${includeLock ? 1 : 0}+${newline ? 1 : 0}+${
            ignoreSpecial ? 1 : 0
        }`,
    );
}

interface SplitOptions {
    readonly lock: boolean;
    readonly newline: boolean;
    readonly ignoreSpecial: boolean;
}

type IndexGetter = (
    segment: AlignmentSegment,
    index: number,
) => readonly number[];

// Port of WhisperResult._split_segments (result.py:1440-1488). Segments are walked
// backwards so splitting one does not invalidate the positions of the others. Python
// warns about segments without word timings here; this package never logs, and such a
// segment is simply left alone.
function splitSegments(
    state: RegroupState,
    getIndices: IndexGetter,
    options: SplitOptions,
): void {
    if (options.lock) {
        throw new StemalignError(
            'invalid-option',
            'regroup: word locks are not modelled, so lock must stay off',
            { expected: 'lock false', actual: 'lock true' },
        );
    }
    for (let index = state.segments.length - 1; index >= 0; index -= 1) {
        const segment = state.segments[index];
        if (segment.words.length === 0) continue;

        const cuts = sortedUnique(getIndices(segment, index));
        if (options.ignoreSpecial) {
            removeSpecialPeriodIndices(segment, cuts);
        }
        if (cuts.length === 0) continue;

        if (options.newline) {
            if (cuts[cuts.length - 1] === segment.words.length - 1) {
                cuts.pop();
                if (cuts.length === 0) continue;
            }
            const breaks = new Set(cuts);
            const words = segment.words.map((word, wordIndex) =>
                breaks.has(wordIndex) && !word.word.endsWith('\n')
                    ? { ...word, word: `${word.word}\n` }
                    : word,
            );
            state.segments[index] = makeSegment(words, metaOf(segment));
            continue;
        }

        state.segments.splice(index, 1, ...splitSegment(segment, cuts));
    }
    state.segments = state.segments.filter(
        (segment) => segment.words.length > 0,
    );
}

// Port of WhisperResult._remove_special_period_indices (result.py:1428-1438): a period
// that ends an abbreviation or a number ("Mr.", "1.5") is not a sentence end. The list
// of candidate indices is edited in place.
function removeSpecialPeriodIndices(
    segment: AlignmentSegment,
    indices: number[],
): void {
    for (let position = indices.length - 1; position >= 0; position -= 1) {
        const word = segment.words[indices[position]].word;
        if (!word.endsWith('.')) continue;
        const stripped = word.trim();
        if (!/^[A-Z0-9]/.test(stripped)) continue;
        if (stripped.replace(/[.A-Z0-9]/g, '').length < 3) {
            indices.splice(position, 1);
        }
    }
}

// Port of Segment.split (result.py:886-902) with Segment.copy (result.py:356-391): the
// split points are word indices, the last word always closes the last segment, and
// every part keeps the metadata of the segment it came from.
function splitSegment(
    segment: AlignmentSegment,
    indices: readonly number[],
): readonly AlignmentSegment[] {
    if (indices.length === 0) return [];
    const cuts = indices.slice();
    if (cuts[cuts.length - 1] !== segment.words.length - 1) {
        cuts.push(segment.words.length - 1);
    }

    const parts: AlignmentSegment[] = [];
    let previous = 0;
    for (const cut of cuts) {
        const next = cut + 1;
        const words = segment.words.slice(previous, next);
        if (words.length > 0) {
            parts.push(makeSegment(words, metaOf(segment)));
        }
        previous = next;
    }
    return parts;
}

// Port of Segment.get_gap_indices (result.py:721-727): the gaps between the words of a
// segment, and the index of the word before every gap above the limit.
function gapIndices(
    segment: AlignmentSegment,
    maxGap: number,
): readonly number[] {
    const words = segment.words;
    if (words.length < 2) return [];
    const indices: number[] = [];
    for (let index = 0; index < words.length - 1; index += 1) {
        if (words[index + 1].start - words[index].end > maxGap) {
            indices.push(index);
        }
    }
    return indices;
}

// Port of Segment.get_punctuation_indices (result.py:729-747). A plain string splits
// after a word ending with it (or before a word starting with it), a pair splits only
// where the trailing string and the leading string meet.
function punctuationIndices(
    segment: AlignmentSegment,
    punctuation: readonly RegroupPunctuation[],
): readonly number[] {
    const words = segment.words;
    if (words.length < 2) return [];
    const indices: number[] = [];
    for (const pattern of punctuation) {
        if (typeof pattern === 'string') {
            for (let index = 0; index < words.length - 1; index += 1) {
                if (words[index].word.endsWith(pattern)) {
                    indices.push(index);
                } else if (
                    index !== 0 &&
                    words[index].word.startsWith(pattern)
                ) {
                    indices.push(index - 1);
                }
            }
            continue;
        }
        const [ending, beginning] = pattern;
        for (let index = 0; index < words.length - 1; index += 1) {
            if (
                words[index].word.endsWith(ending) &&
                words[index + 1].word.startsWith(beginning)
            ) {
                indices.push(index);
            }
        }
    }
    return sortedUnique(indices);
}

function segmentDuration(segment: AlignmentSegment): number {
    return segment.end - segment.start;
}

function segmentCharCount(segment: AlignmentSegment): number {
    return segment.words.reduce(
        (total, word) => total + codePointLength(word.word),
        0,
    );
}

// Port of Segment.split_by_punctuation's _over_max (result.py:1718-1723).
function overMaxLength(
    segment: AlignmentSegment,
    minWords: number | null,
    minChars: number | null,
    minDur: number | null,
): boolean {
    return (
        (Boolean(minWords) && segment.words.length >= (minWords as number)) ||
        (Boolean(minChars) &&
            segmentCharCount(segment) >= (minChars as number)) ||
        (Boolean(minDur) && segmentDuration(segment) >= (minDur as number))
    );
}

interface LengthOptions {
    readonly maxChars: number | null;
    readonly maxWords: number | null;
    readonly evenSplit: boolean;
}

// Port of Segment.get_length_indices (result.py:788-851) without locks, so the locked
// indices are always empty. `even_split` picks the nearest cumulative counts, the
// sequential walk cuts after the word that pushes the segment over a limit.
function lengthIndices(
    segment: AlignmentSegment,
    options: LengthOptions,
): readonly number[] {
    const words = segment.words;
    const { maxChars, maxWords, evenSplit } = options;
    if (words.length < 2 || (maxChars === null && maxWords === null)) return [];
    if (maxChars === 0 || maxWords === 0) {
        throw new StemalignError(
            'invalid-option',
            `regroup: max_chars and max_words must be greater than 0, but got ${maxChars} and ${maxWords}`,
            {
                expected: 'a positive limit or none',
                actual: `${maxChars} and ${maxWords}`,
            },
        );
    }

    if (!evenSplit) {
        const indices: number[] = [];
        let currentWords = 0;
        let currentChars = 0;
        for (let index = 0; index < words.length; index += 1) {
            currentWords += 1;
            currentChars += codePointLength(words[index].word);
            const exceededChars = maxChars !== null && currentChars > maxChars;
            const exceededWords = maxWords !== null && currentWords > maxWords;
            if (index !== 0 && (exceededChars || exceededWords)) {
                indices.push(index - 1);
                currentWords = 1;
                currentChars = codePointLength(words[index].word);
            }
        }
        return indices;
    }

    let indices: readonly number[] = [];
    const charCount =
        maxChars === null
            ? -1
            : words.reduce(
                  (total, word) => total + codePointLength(word.word),
                  0,
              );
    const wordCount = maxWords === null ? -1 : words.length;
    let exceededWords = maxWords !== null && wordCount > maxWords;

    if (maxChars !== null && charCount > maxChars) {
        const splits = Math.ceil(charCount / maxChars);
        const charactersPerSplit = charCount / splits;
        indices = evenSplitIndices(
            cumulativeLengths(words, false),
            charactersPerSplit,
            splits,
        );
        if (maxWords !== null) {
            const bounds = [0, ...indices, words.length];
            exceededWords = false;
            for (let position = 1; position < bounds.length; position += 1) {
                if (bounds[position] - bounds[position - 1] > maxWords) {
                    exceededWords = true;
                    break;
                }
            }
        }
    }

    if (exceededWords) {
        const splits = Math.ceil(wordCount / (maxWords as number));
        const wordsPerSplit = wordCount / splits;
        indices = evenSplitIndices(
            cumulativeLengths(words, true),
            wordsPerSplit,
            splits,
        );
    }
    return indices;
}

// The cumulative counts Python builds for the even split: the character counts of
// every word but the last (result.py:815), or the word counts of every word
// (result.py:828).
function cumulativeLengths(
    words: readonly WordTiming[],
    byWord: boolean,
): readonly number[] {
    const cumulative: number[] = [];
    let total = 0;
    const last = byWord ? words.length : words.length - 1;
    for (let index = 0; index < last; index += 1) {
        total += byWord ? 1 : codePointLength(words[index].word);
        cumulative.push(total);
    }
    return cumulative;
}

// Port of Segment._get_even_split_indices (result.py:760-786) without excluded
// indices, so the nearest cumulative count is picked for every split point (numpy's
// argmin returns the first minimum, so ties go to the earlier word).
function evenSplitIndices(
    cumulative: readonly number[],
    partsPerSplit: number,
    splits: number,
): readonly number[] {
    const indices: number[] = [];
    for (let position = 1; position < splits; position += 1) {
        const target = position * partsPerSplit;
        let best = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < cumulative.length; index += 1) {
            const distance = Math.abs(cumulative[index] - target);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = index;
            }
        }
        indices.push(best);
    }
    return sortedUnique(indices);
}
