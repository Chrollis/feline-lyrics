import { StemalignError } from '../errors.js';
import type { SilenceSpan } from './non-speech.js';
import { suppressSilence } from './suppress-silence.js';
import type { WordTiming } from './timestamps.js';
import { DEFAULT_APPEND_PUNCTUATIONS } from './words.js';

// A segment is what stable_whisper.result.Segment.to_dict reports (result.py:609-636):
// the shape fields come from the words, the metadata fields are carried over from the
// segment a split started from (the regroup golden fixture pins both, see b172/b173).
export interface AlignmentSegment {
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

export type SegmentMeta = Pick<
    AlignmentSegment,
    | 'seek'
    | 'temperature'
    | 'avg_logprob'
    | 'compression_ratio'
    | 'no_speech_prob'
>;

// Python len() counts code points, so a split offset is a code point offset too.
function codePointLength(text: string): number {
    return [...text].length;
}

function checkCharIndexes(charIndexes: readonly number[]): void {
    for (const index of charIndexes) {
        if (!Number.isInteger(index) || index < 1) {
            throw new StemalignError(
                'invalid-option',
                `a split character index must be a positive integer, got ${index}`,
                { expected: 'a positive integer', actual: String(index) },
            );
        }
    }
    for (let position = 1; position < charIndexes.length; position++) {
        if (charIndexes[position] < charIndexes[position - 1]) {
            throw new StemalignError(
                'invalid-option',
                `the split character indexes must ascend, got ${charIndexes.join(', ')}`,
                {
                    expected: 'ascending character indexes',
                    actual: charIndexes.join(', '),
                },
            );
        }
    }
}

export function makeSegment(
    words: readonly WordTiming[],
    meta: Partial<SegmentMeta> = {},
): AlignmentSegment {
    let text = '';
    const tokens: number[] = [];
    for (const word of words) {
        text += word.word;
        for (const token of word.tokens) tokens.push(token);
    }
    return {
        // Segment() without words reports zeros, exactly like _default_start/_default_end.
        start: words.length > 0 ? words[0].start : 0,
        end: words.length > 0 ? words[words.length - 1].end : 0,
        text,
        seek: meta.seek ?? null,
        // The tokens of a words based segment are the tokens of its words (result.py:308-311).
        tokens: words.length > 0 ? tokens : null,
        temperature: meta.temperature ?? null,
        avg_logprob: meta.avg_logprob ?? null,
        compression_ratio: meta.compression_ratio ?? null,
        no_speech_prob: meta.no_speech_prob ?? null,
        words,
    };
}

// Split at character offsets: an offset is where a following segment starts when the
// words are concatenated. The trailing words always stay in the last segment.
export function splitSegmentByChars(
    words: readonly WordTiming[],
    charIndexes: readonly number[],
    meta: Partial<SegmentMeta> = {},
): readonly AlignmentSegment[] {
    checkCharIndexes(charIndexes);
    if (charIndexes.length === 0) return [makeSegment(words, meta)];

    const cumulative: number[] = [];
    let total = 0;
    for (const word of words) {
        total += codePointLength(word.word);
        cumulative.push(total);
    }

    const bounds = [0];
    for (const index of charIndexes) {
        let split = words.length;
        for (let position = 0; position < cumulative.length; position++) {
            if (cumulative[position] >= index) {
                split = position + 1;
                break;
            }
        }
        bounds.push(split);
    }
    bounds.push(words.length);

    const segments: AlignmentSegment[] = [];
    for (let position = 1; position < bounds.length; position++) {
        const from = bounds[position - 1];
        const to = bounds[position];
        if (from === to) continue;
        segments.push(makeSegment(words.slice(from, to), meta));
    }
    return segments;
}

export interface SegmentSuppressOptions {
    readonly minWordDur: number;
    readonly nonspeechError: number;
    /** Suppress every word; when false only the edge words of the segment are touched. */
    readonly wordLevel: boolean;
    /** Let the trailing punctuation and the word position pick the edge that is kept. */
    readonly useWordPosition: boolean;
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

// stable_whisper.result.Segment.suppress_silence (result.py:681-705): every word is
// suppressed on its own, keep_end comes from the last character of the word and its
// position inside the segment, and with word_level off only the first and the last word
// of the segment are touched. The punctuation set is DEFAULT_KWARGS append_punctuations
// (stable_whisper/default.py:6).
export function suppressSegmentSilence(
    segment: AlignmentSegment,
    silences: readonly SilenceSpan[],
    options: SegmentSuppressOptions,
): AlignmentSegment {
    const words = segment.words;
    if (words.length === 0) return segment;

    const indexes =
        options.wordLevel || words.length === 1
            ? words.map((_word, index) => index)
            : [0, words.length - 1];
    const suppressed = words.slice();
    for (const [position, wordIndex] of indexes.entries()) {
        const word = words[wordIndex];
        const keepEnd = options.useWordPosition
            ? !(
                  DEFAULT_APPEND_PUNCTUATIONS.includes(word.word.slice(-1)) ||
                  position + 1 === indexes.length
              )
            : null;
        const span = suppressSilence(word, silences, {
            minWordDur: options.minWordDur,
            nonspeechError: options.nonspeechError,
            keepEnd,
        });
        suppressed[wordIndex] = { ...word, start: span.start, end: span.end };
    }
    return makeSegment(suppressed, metaOf(segment));
}
