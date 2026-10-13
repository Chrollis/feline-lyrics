import { StemalignError } from '../errors.js';
import type { ModelHandle } from '../model/session.js';
import type { WhisperSettings } from './settings.js';
import { WHISPER_ENCODER_DOWNSAMPLE } from './whisper.js';

export interface WhisperTokenizer {
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

interface TokenizerFile {
    readonly model?: {
        readonly type?: unknown;
        readonly vocab?: unknown;
        readonly merges?: unknown;
    };
    readonly added_tokens?: unknown;
}

const PRINTABLE_RANGES: readonly (readonly [number, number])[] = [
    [33, 126],
    [161, 172],
    [174, 255],
];

const characterToByte = new Map<string, number>();
const byteToCharacter = new Array<string>(256);
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8');

const printable = new Uint8Array(256);
for (const [start, end] of PRINTABLE_RANGES) {
    for (let byte = start; byte <= end; byte += 1) {
        printable[byte] = 1;
    }
}
let unmappedCodePoint = 256;
for (let byte = 0; byte < 256; byte += 1) {
    const codePoint = printable[byte] === 1 ? byte : unmappedCodePoint;
    if (printable[byte] === 0) {
        unmappedCodePoint += 1;
    }
    characterToByte.set(String.fromCodePoint(codePoint), byte);
    byteToCharacter[byte] = String.fromCodePoint(codePoint);
}

const GPT2_PATTERN =
    /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

function describeValue(value: unknown): string {
    if (typeof value === 'string') {
        return value.length > 32
            ? `${JSON.stringify(value.slice(0, 32))}...`
            : JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `an array of ${value.length}`;
    }
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'object') {
        return 'an object';
    }
    return String(value);
}

function checkPiece(piece: string, modelId: string): void {
    for (const character of piece) {
        if (!characterToByte.has(character)) {
            throw new StemalignError(
                'setting-mismatch',
                `the tokenizer maps the piece ${describeValue(piece)}, which is outside the byte alphabet`,
                {
                    modelId,
                    expected: 'byte level pieces',
                    actual: describeValue(character),
                },
            );
        }
    }
}

function checkTokenId(
    value: unknown,
    vocabSize: number,
    modelId: string,
): number {
    if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value >= vocabSize
    ) {
        throw new StemalignError(
            'setting-mismatch',
            `the tokenizer carries the token id ${describeValue(value)}, which is outside a vocabulary of ${vocabSize} entries`,
            {
                modelId,
                expected: `an integer in [0, ${vocabSize - 1}]`,
                actual: describeValue(value),
            },
        );
    }
    return value;
}

function checkId(id: number, vocabSize: number, modelId: string): void {
    if (!Number.isInteger(id) || id < 0 || id >= vocabSize) {
        throw new StemalignError(
            'invalid-option',
            `the token id ${id} is outside a vocabulary of ${vocabSize} entries`,
            {
                modelId,
                expected: `an integer in [0, ${vocabSize - 1}]`,
                actual: `${id}`,
            },
        );
    }
}

export function inspectWhisperTokenizer(
    handle: ModelHandle,
    settings: WhisperSettings,
): WhisperTokenizer {
    const source: string | undefined = handle.settings['tokenizer'];
    if (source === undefined) {
        throw new StemalignError(
            'missing-setting',
            'the model settings must carry the tokenizer.json text under the "tokenizer" key',
            {
                modelId: handle.id,
                expected: 'a tokenizer.json document',
                actual: 'undefined',
            },
        );
    }

    let parsed: TokenizerFile;
    try {
        parsed = JSON.parse(source) as TokenizerFile;
    } catch (error) {
        throw new StemalignError(
            'missing-setting',
            'the "tokenizer" setting is not valid JSON',
            { modelId: handle.id, expected: 'a tokenizer.json document' },
            { cause: error },
        );
    }

    const model = parsed.model;
    if (model === undefined || model.type !== 'BPE') {
        throw new StemalignError(
            'setting-mismatch',
            `the tokenizer must describe a BPE model, got ${describeValue(model?.type)}`,
            { modelId: handle.id, expected: 'BPE' },
        );
    }

    const vocabSize = settings.vocabSize;
    const pieces = new Array<string>(vocabSize);
    const vocabIds = new Map<string, number>();
    const filled = new Uint8Array(vocabSize);
    let filledCount = 0;

    const vocab = model.vocab;
    if (vocab === null || typeof vocab !== 'object' || Array.isArray(vocab)) {
        throw new StemalignError(
            'missing-setting',
            `the tokenizer must carry a vocabulary, got ${describeValue(vocab)}`,
            { modelId: handle.id, expected: 'an object of piece to id' },
        );
    }
    for (const [piece, id] of Object.entries(
        vocab as Record<string, unknown>,
    )) {
        const tokenId = checkTokenId(id, vocabSize, handle.id);
        checkPiece(piece, handle.id);
        if (filled[tokenId] === 0) {
            filled[tokenId] = 1;
            filledCount += 1;
        }
        pieces[tokenId] = piece;
        vocabIds.set(piece, tokenId);
    }

    const specialTokens = new Map<number, string>();
    const specialIds = new Map<string, number>();
    const added = parsed.added_tokens;
    if (added !== undefined) {
        if (!Array.isArray(added)) {
            throw new StemalignError(
                'missing-setting',
                `the tokenizer added_tokens must be an array, got ${describeValue(added)}`,
                { modelId: handle.id, expected: 'an array' },
            );
        }
        for (const entry of added) {
            if (entry === null || typeof entry !== 'object') {
                throw new StemalignError(
                    'setting-mismatch',
                    `every added token must be an object, got ${describeValue(entry)}`,
                    {
                        modelId: handle.id,
                        expected: 'an object with id and content',
                    },
                );
            }
            const record = entry as {
                readonly id?: unknown;
                readonly content?: unknown;
            };
            const tokenId = checkTokenId(record.id, vocabSize, handle.id);
            const content = record.content;
            if (typeof content !== 'string') {
                throw new StemalignError(
                    'setting-mismatch',
                    `the added token ${tokenId} must carry string content, got ${describeValue(content)}`,
                    {
                        modelId: handle.id,
                        tensor: `${tokenId}`,
                        expected: 'a string',
                    },
                );
            }
            specialTokens.set(tokenId, content);
            if (filled[tokenId] === 0) {
                filled[tokenId] = 1;
                filledCount += 1;
            }
            pieces[tokenId] = content;
            specialIds.set(content, tokenId);
        }
    }
    const merges = model.merges;
    if (!Array.isArray(merges)) {
        throw new StemalignError(
            'missing-setting',
            `the tokenizer must carry merge ranks, got ${describeValue(merges)}`,
            { modelId: handle.id, expected: 'an array of merge strings' },
        );
    }
    const mergeRanks = new Map<string, number>();
    for (const [rank, merge] of merges.entries()) {
        if (typeof merge !== 'string') {
            throw new StemalignError(
                'setting-mismatch',
                `every merge must be a string, got ${describeValue(merge)}`,
                { modelId: handle.id, expected: 'a merge string' },
            );
        }
        const separator = merge.indexOf(' ');
        if (separator <= 0 || separator !== merge.lastIndexOf(' ')) {
            throw new StemalignError(
                'setting-mismatch',
                `the merge ${describeValue(merge)} is not a pair of pieces`,
                {
                    modelId: handle.id,
                    expected: 'two pieces separated by a space',
                },
            );
        }
        mergeRanks.set(merge, rank);
    }
    if (filledCount !== vocabSize) {
        throw new StemalignError(
            'setting-mismatch',
            `the tokenizer fills ${filledCount} of ${vocabSize} token ids`,
            {
                modelId: handle.id,
                expected: `all ${vocabSize} ids`,
                actual: `${filledCount}`,
            },
        );
    }

    const timestampBegin = settings.noTimestampsTokenId + 1;
    if (timestampBegin >= vocabSize) {
        throw new StemalignError(
            'setting-mismatch',
            `a vocabulary of ${vocabSize} entries leaves no room for a timestamp token after ${settings.noTimestampsTokenId}`,
            {
                modelId: handle.id,
                expected: `a no timestamps token below ${vocabSize - 1}`,
                actual: `${settings.noTimestampsTokenId}`,
            },
        );
    }
    const timestampEnd = vocabSize - 1;
    const secondsPerToken =
        (WHISPER_ENCODER_DOWNSAMPLE * settings.hopLength) / settings.sampleRate;

    function toByteLevel(text: string): string {
        let symbol = '';
        for (const byte of UTF8_ENCODER.encode(text)) {
            symbol += byteToCharacter[byte];
        }
        return symbol;
    }

    function mergeSymbols(piece: string): readonly string[] {
        let symbols = Array.from(piece);
        while (symbols.length > 1) {
            let bestRank = Number.POSITIVE_INFINITY;
            let bestIndex = -1;
            for (let index = 0; index < symbols.length - 1; index += 1) {
                const rank = mergeRanks.get(
                    `${symbols[index]} ${symbols[index + 1]}`,
                );
                if (rank !== undefined && rank < bestRank) {
                    bestRank = rank;
                    bestIndex = index;
                }
            }
            if (bestIndex === -1) {
                break;
            }
            symbols = [
                ...symbols.slice(0, bestIndex),
                symbols[bestIndex] + symbols[bestIndex + 1],
                ...symbols.slice(bestIndex + 2),
            ];
        }
        return symbols;
    }

    function encodeText(text: string): readonly number[] {
        const ids: number[] = [];
        const pattern = /<\|[^|>]+\|>/g;
        const parts: { text: string; special: boolean }[] = [];
        let last = 0;
        let match = pattern.exec(text);
        while (match !== null) {
            if (match.index > last) {
                parts.push({
                    text: text.slice(last, match.index),
                    special: false,
                });
            }
            parts.push({ text: match[0], special: true });
            last = match.index + match[0].length;
            match = pattern.exec(text);
        }
        if (last < text.length) {
            parts.push({ text: text.slice(last), special: false });
        }
        for (const part of parts) {
            if (part.special) {
                const id = specialIds.get(part.text);
                if (id === undefined) {
                    throw new StemalignError(
                        'invalid-option',
                        `the text carries the unknown special token ${describeValue(part.text)}`,
                        {
                            modelId: handle.id,
                            expected: 'a token present in tokenizer.json',
                        },
                    );
                }
                ids.push(id);
                continue;
            }
            for (const segment of part.text.match(GPT2_PATTERN) ?? []) {
                for (const symbol of mergeSymbols(toByteLevel(segment))) {
                    const id = vocabIds.get(symbol);
                    if (id === undefined) {
                        throw new StemalignError(
                            'model-invalid',
                            `the vocabulary has no entry for the byte level symbol ${describeValue(symbol)}`,
                            {
                                modelId: handle.id,
                                expected: 'a complete byte level vocabulary',
                            },
                        );
                    }
                    ids.push(id);
                }
            }
        }
        return ids;
    }

    function textOf(id: number): string {
        checkId(id, vocabSize, handle.id);
        const text = specialTokens.get(id);
        return text ?? pieces[id];
    }

    return {
        vocabSize,
        timestampBegin,
        timestampEnd,
        tokenText: textOf,
        isSpecialToken(id: number): boolean {
            checkId(id, vocabSize, handle.id);
            return specialTokens.has(id);
        },
        isTimestampToken(id: number): boolean {
            checkId(id, vocabSize, handle.id);
            return id >= timestampBegin;
        },
        timestampSeconds(id: number): number {
            checkId(id, vocabSize, handle.id);
            if (id < timestampBegin) {
                throw new StemalignError(
                    'invalid-option',
                    `the token ${id} is not a timestamp token`,
                    {
                        modelId: handle.id,
                        expected: `an integer in [${timestampBegin}, ${timestampEnd}]`,
                        actual: `${id}`,
                    },
                );
            }
            return (id - timestampBegin) * secondsPerToken;
        },
        encode: encodeText,
        decode(ids: readonly number[]): string {
            const bytes: number[] = [];
            for (const id of ids) {
                checkId(id, vocabSize, handle.id);
                const special = specialTokens.get(id);
                if (special !== undefined) {
                    for (const byte of UTF8_ENCODER.encode(special)) {
                        bytes.push(byte);
                    }
                    continue;
                }
                for (const character of pieces[id]) {
                    const byte = characterToByte.get(character);
                    if (byte === undefined) {
                        throw new StemalignError(
                            'setting-mismatch',
                            `the token piece of ${id} carries ${describeValue(character)}, which is outside the byte alphabet`,
                            { modelId: handle.id, tensor: `${id}` },
                        );
                    }
                    bytes.push(byte);
                }
            }
            return UTF8_DECODER.decode(Uint8Array.from(bytes));
        },
    };
}
