import { LyricoreError } from '../errors.js';
import {
    exportToLyrics,
    lyricsToExport,
    META_KEYS,
    type LyricsFile,
} from '../lyrics/file.js';
import {
    overlayContextOf,
    overlayOf,
    rebuild,
    type LyricsLine,
} from '../lyrics/line.js';
import { NO_ANIMATIONS, type Lyrics } from '../lyrics/lyrics.js';
import {
    assertOverlay,
    EMPTY_ANNOTATIONS,
    EMPTY_BLOCK_STYLES,
    EMPTY_INSERTED_OBJECTS,
    EMPTY_RUN_STYLES,
    EMPTY_STYLE_RUNS,
    mergeAdjacentStyleRuns,
    NO_OVERLAY,
    overlayProblem,
    type AnnotationStyleRun,
    type BlockStyleRun,
    type ImageContent,
    type InsertContent,
    type InsertedObject,
    type LineOverlay,
    type RunStyleRun,
    type StyleRun,
    type TextContent,
} from '../lyrics/overlay.js';
import {
    assertStyleBook,
    emptyStyleBook,
    isStyleSpace,
    styleBookProblem,
    styleDefProblem,
    styleIds,
    styleSpace,
    type StyleBook,
    type StyleDef,
    type StyleSpace,
} from '../lyrics/stylebook.js';
import { contentProblem, type StyleContent } from '../lyrics/stylecontent.js';
import { MIGRATIONS } from './migrate.js';

/** What a project file calls itself. One id, one version for the whole file. */
export const PROJECT_FORMAT = 'felyrics/lyrics-project';
export const PROJECT_VERSION = 1;

/**
 * The project document, as it goes to disk.
 *
 * The lyrics block is embedded as a VALUE, produced by the frozen writer and
 * read back by the frozen reader, so the project file cannot drift from the
 * standalone export. Everything the export does not carry - the style table,
 * the per-line overlay, the animation layer - sits in sibling sections.
 *
 * The overlay is a PARALLEL ARRAY here, one entry per line, while in memory it
 * lives inside each line. Zipping and unzipping happen in `json.ts` only.
 */
export interface ProjectFile {
    readonly format: typeof PROJECT_FORMAT;
    readonly version: typeof PROJECT_VERSION;
    readonly lyrics: LyricsFile;
    readonly styleBook?: StyleBookFile;
    readonly overlay?: readonly OverlayEntryFile[];
    readonly animations?: readonly unknown[];
}

export interface StyleBookFile {
    readonly defs?: Readonly<Record<string, StyleDefFile>>;
}

export interface StyleDefFile {
    readonly basedOn?: string;
    readonly space?: StyleSpace;
    readonly content?: StyleContent;
}

/** One line's overlay. `{}` is the canonical "nothing here" entry. */
export interface OverlayEntryFile {
    readonly styles?: readonly StyleRunFile[];
    readonly inserted?: readonly InsertedObjectFile[];
    readonly blocks?: readonly BlockStyleFile[];
    readonly runStyles?: readonly RunStyleFile[];
    readonly annotations?: readonly AnnotationStyleFile[];
}

export interface StyleRunFile {
    readonly offset: number;
    readonly length: number;
    readonly styleId: string;
}

/** `from` is the entry's identity, so it is written even when it is null. */
export interface BlockStyleFile {
    readonly from: string | null;
    readonly styleId: string;
}

export interface RunStyleFile {
    readonly group: string;
    readonly offset: number;
    readonly styleId: string;
}

export interface AnnotationStyleFile {
    readonly group: string;
    readonly runOffset: number;
    readonly offset: number;
    readonly length: number;
    readonly styleId: string;
}

export interface InsertedObjectFile {
    readonly id: string;
    readonly kind: string;
    readonly anchor: readonly [offset: number, length: number];
    readonly content?: InsertContentFile;
    readonly time?: readonly [start: number, duration: number];
}

export interface TextContentFile {
    readonly type: 'text';
    readonly lines: readonly string[];
    readonly styleId?: string;
}

export interface ImageContentFile {
    readonly type: 'image';
    readonly src: string;
    readonly wipedSrc?: string | null;
    readonly scale?: number | null;
}

export type InsertContentFile = TextContentFile | ImageContentFile;

/** Something a load noticed without refusing the file. */
export interface ProjectIssue {
    readonly code: 'style-orphan';
    readonly styleId: string;
}

/**
 * What a read returns: the document, plus what the load wanted to say.
 *
 * Issues are not part of `Lyrics` - a document that could not be written would
 * be a document that remembers its own history. `LossCollector` is the wrong
 * tool here: a loss is incurred converting someone else's format, an issue is
 * an observation about one of ours.
 */
export interface ProjectRead {
    readonly lyrics: Lyrics;
    readonly issues: readonly ProjectIssue[];
}

const PROJECT_KEYS = [
    'format',
    'version',
    'lyrics',
    'styleBook',
    'overlay',
    'animations',
] as const;
const LYRICS_KEYS = ['format', 'version', 'meta', 'lines'] as const;
const LINE_KEYS = ['text', 'spans', 'groups'] as const;
const RUN_KEYS = ['offset', 'length', 'pieces'] as const;
const PIECE_KEYS = ['check', 'text', 'spans'] as const;
const CHECK_KEYS = ['time', 'type'] as const;
const STYLE_BOOK_KEYS = ['defs'] as const;
const STYLE_DEF_KEYS = ['basedOn', 'space', 'content'] as const;
const OVERLAY_ENTRY_KEYS = [
    'styles',
    'inserted',
    'blocks',
    'runStyles',
    'annotations',
] as const;
const STYLE_RUN_KEYS = ['offset', 'length', 'styleId'] as const;
const BLOCK_STYLE_KEYS = ['from', 'styleId'] as const;
const RUN_STYLE_KEYS = ['group', 'offset', 'styleId'] as const;
const ANNOTATION_KEYS = [
    'group',
    'runOffset',
    'offset',
    'length',
    'styleId',
] as const;
const INSERTED_KEYS = ['id', 'kind', 'anchor', 'content', 'time'] as const;
const TEXT_CONTENT_KEYS = ['type', 'lines', 'styleId'] as const;
const IMAGE_CONTENT_KEYS = ['type', 'src', 'wipedSrc', 'scale'] as const;

function fail(path: string, detail: string): never {
    const where = path === '' ? 'the document' : path;
    throw new LyricoreError('invalid-project-file', `${where}: ${detail}`, {
        expected: 'a valid felyrics/lyrics-project value',
        actual: detail,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
    if (!isRecord(value)) {
        fail(path, 'is not an object');
    }
    return value;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
    if (!Array.isArray(value)) {
        fail(path, 'is not an array');
    }
    return value;
}

function stringAt(value: unknown, path: string): string {
    if (typeof value !== 'string') {
        fail(path, 'is not a string');
    }
    return value;
}

function filledStringAt(value: unknown, path: string): string {
    const text = stringAt(value, path);
    if (text === '') {
        fail(path, 'is empty');
    }
    return text;
}

function integerAt(value: unknown, path: string, min: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
        fail(path, `is not an integer >= ${min}`);
    }
    return value;
}

/** Keys are closed at every depth; a value the design calls open stays open. */
function closedKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
    path: string,
): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            fail(path === '' ? key : `${path}.${key}`, 'is not a key here');
        }
    }
}

/**
 * The sweep the frozen reader cannot do.
 *
 * `exportToLyrics` reads `format`, `version`, `meta` and `lines` and ignores
 * everything else, so an overlay smuggled into the lyrics block would load and
 * then disappear on the next save. This runs BEFORE the block is handed over.
 */
function sweepLyricsBlock(value: unknown): void {
    const block = recordAt(value, 'lyrics');
    closedKeys(block, LYRICS_KEYS, 'lyrics');
    if (block.meta !== undefined) {
        // `metaFromFile` rebuilds the metadata from the fields it knows, so an
        // unknown key here is dropped just as silently as one on a line.
        const meta = recordAt(block.meta, 'lyrics.meta');
        closedKeys(meta, META_KEYS, 'lyrics.meta');
    }
    const lines = arrayAt(block.lines, 'lyrics.lines');
    lines.forEach((lineValue, lineIndex) => {
        const linePath = `lyrics.lines[${lineIndex}]`;
        const line = recordAt(lineValue, linePath);
        closedKeys(line, LINE_KEYS, linePath);
        if (line.groups === undefined) {
            return;
        }
        const groups = recordAt(line.groups, `${linePath}.groups`);
        for (const [name, runsValue] of Object.entries(groups)) {
            const groupPath = `${linePath}.groups.${name}`;
            const runs = arrayAt(runsValue, groupPath);
            runs.forEach((runValue, runIndex) => {
                const runPath = `${groupPath}[${runIndex}]`;
                const run = recordAt(runValue, runPath);
                closedKeys(run, RUN_KEYS, runPath);
                const pieces = arrayAt(run.pieces, `${runPath}.pieces`);
                pieces.forEach((pieceValue, pieceIndex) => {
                    const piecePath = `${runPath}.pieces[${pieceIndex}]`;
                    const piece = recordAt(pieceValue, piecePath);
                    closedKeys(piece, PIECE_KEYS, piecePath);
                    // `checkFromFile` rebuilds the check from time and type, so
                    // anything else inside it would be dropped the same way.
                    if (piece.check !== null && piece.check !== undefined) {
                        const checkPath = `${piecePath}.check`;
                        closedKeys(
                            recordAt(piece.check, checkPath),
                            CHECK_KEYS,
                            checkPath,
                        );
                    }
                });
            });
        }
    });
}

function readLyricsBlock(value: unknown): Lyrics {
    sweepLyricsBlock(value);
    try {
        return exportToLyrics(value);
    } catch (error) {
        // One file, one code: the frozen reader's code does not escape a
        // project read. Its path is merged into the block's, so a bad span
        // reports `lyrics.lines[0].spans`, not `lyrics`.
        const message = error instanceof Error ? error.message : String(error);
        const at = / at ([A-Za-z][A-Za-z0-9_.[\]]*)$/.exec(message);
        if (at !== null) {
            return fail(`lyrics.${at[1]}`, message.slice(0, at.index));
        }
        return fail('lyrics', message);
    }
}

function readStyleBook(value: unknown): StyleBook {
    if (value === undefined) {
        return emptyStyleBook();
    }
    const book = recordAt(value, 'styleBook');
    closedKeys(book, STYLE_BOOK_KEYS, 'styleBook');
    if (book.defs === undefined) {
        return emptyStyleBook();
    }
    const defsValue = recordAt(book.defs, 'styleBook.defs');
    const defs: Record<string, StyleDef> = {};
    for (const [id, defValue] of Object.entries(defsValue)) {
        const path = `styleBook.defs.${id}`;
        const def = recordAt(defValue, path);
        closedKeys(def, STYLE_DEF_KEYS, path);
        const basedOn =
            def.basedOn === undefined
                ? null
                : stringAt(def.basedOn, `${path}.basedOn`);
        const space =
            def.space === undefined
                ? undefined
                : styleSpaceAt(def.space, `${path}.space`);
        const content =
            def.content === undefined
                ? {}
                : readStyleContent(
                      def.content,
                      space ?? 'character',
                      `${path}.content`,
                  );
        // An id shaped like `__proto__` has to stay an ordinary key, so it is
        // defined rather than assigned.
        Object.defineProperty(defs, id, {
            value: {
                basedOn: basedOn === '' ? null : basedOn,
                ...(space === undefined ? {} : { space }),
                content,
            },
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    const book2: StyleBook = { defs };
    // Per definition first, so the message names the leaf (`...defs.chorus`)
    // rather than the table. Cycles have no single leaf and fall through.
    for (const id of Object.keys(defs)) {
        const problem = styleDefProblem(book2, id);
        if (problem !== null) {
            fail(`styleBook.defs.${id}`, problem);
        }
    }
    const problem = styleBookProblem(book2);
    if (problem !== null) {
        fail('styleBook', problem);
    }
    return book2;
}

function styleSpaceAt(value: unknown, path: string): StyleSpace {
    if (!isStyleSpace(value)) {
        fail(
            path,
            `is ${JSON.stringify(value)}, not 'character', 'run' or 'paragraph'`,
        );
    }
    return value;
}

/**
 * The content of one definition, checked against the space it belongs to.
 *
 * The JSON is closed: a key the space does not have, a value of the wrong type,
 * a gradient with one stop - all of them stop the load with the leaf path
 * (`styleBook.defs.chorus.content.fill.normal.color`).
 */
function readStyleContent(
    value: unknown,
    space: StyleSpace,
    path: string,
): StyleContent {
    const content = recordAt(value, path);
    const problem = contentProblem(space, content);
    if (problem !== null) {
        fail(path, problem);
    }
    return content as StyleContent;
}

function readOverlays(
    value: unknown,
    lines: readonly LyricsLine[],
): readonly LineOverlay[] {
    if (value === undefined) {
        return lines.map(() => NO_OVERLAY);
    }
    const entries = arrayAt(value, 'overlay');
    if (entries.length !== lines.length) {
        fail(
            'overlay',
            `holds ${entries.length} entries for ${lines.length} lines`,
        );
    }
    return entries.map((entry, index) =>
        readOverlayEntry(entry, `overlay[${index}]`, lines[index]),
    );
}

function readOverlayEntry(
    value: unknown,
    path: string,
    line: LyricsLine,
): LineOverlay {
    const entry = recordAt(value, path);
    closedKeys(entry, OVERLAY_ENTRY_KEYS, path);
    const styles =
        entry.styles === undefined
            ? EMPTY_STYLE_RUNS
            : arrayAt(entry.styles, `${path}.styles`).map((run, index) =>
                  readStyleRunFile(run, `${path}.styles[${index}]`),
              );
    const inserted =
        entry.inserted === undefined
            ? EMPTY_INSERTED_OBJECTS
            : arrayAt(entry.inserted, `${path}.inserted`).map((object, index) =>
                  readInsertedFile(object, `${path}.inserted[${index}]`),
              );
    const blocks =
        entry.blocks === undefined
            ? EMPTY_BLOCK_STYLES
            : arrayAt(entry.blocks, `${path}.blocks`).map((item, index) =>
                  readBlockStyleFile(item, `${path}.blocks[${index}]`),
              );
    const runStyles =
        entry.runStyles === undefined
            ? EMPTY_RUN_STYLES
            : arrayAt(entry.runStyles, `${path}.runStyles`).map((item, index) =>
                  readRunStyleFile(item, `${path}.runStyles[${index}]`),
              );
    const annotations =
        entry.annotations === undefined
            ? EMPTY_ANNOTATIONS
            : arrayAt(entry.annotations, `${path}.annotations`).map(
                  (item, index) =>
                      readAnnotationFile(item, `${path}.annotations[${index}]`),
              );
    const candidate: LineOverlay = {
        styles,
        inserted,
        blocks,
        runStyles,
        annotations,
    };
    const problem = overlayProblem(candidate, overlayContextOf(line));
    if (problem !== null) {
        // `overlayProblem` words its path as `overlay.styles[0]`; inside an
        // entry the entry's own index is the root, so drop the prefix.
        fail(path, problem.message.replace(/^overlay\./, ''));
    }
    // Adjacent runs that name the same style are one run, and a reader must
    // accept what it would otherwise have to reject. Overlap was ruled out
    // above, so merging cannot lose anything.
    return { ...candidate, styles: mergeAdjacentStyleRuns(styles) };
}

function readBlockStyleFile(value: unknown, path: string): BlockStyleRun {
    const entry = recordAt(value, path);
    closedKeys(entry, BLOCK_STYLE_KEYS, path);
    // `from` is the entry's identity, so an absent one is a rejection even
    // though `null` is a legal value: the two would otherwise mean one thing.
    const from =
        entry.from === null ? null : stringAt(entry.from, `${path}.from`);
    return { from, styleId: filledStringAt(entry.styleId, `${path}.styleId`) };
}

function readRunStyleFile(value: unknown, path: string): RunStyleRun {
    const entry = recordAt(value, path);
    closedKeys(entry, RUN_STYLE_KEYS, path);
    return {
        group: filledStringAt(entry.group, `${path}.group`),
        offset: integerAt(entry.offset, `${path}.offset`, 0),
        styleId: filledStringAt(entry.styleId, `${path}.styleId`),
    };
}

function readAnnotationFile(value: unknown, path: string): AnnotationStyleRun {
    const entry = recordAt(value, path);
    closedKeys(entry, ANNOTATION_KEYS, path);
    return {
        group: filledStringAt(entry.group, `${path}.group`),
        runOffset: integerAt(entry.runOffset, `${path}.runOffset`, 0),
        offset: integerAt(entry.offset, `${path}.offset`, 0),
        length: integerAt(entry.length, `${path}.length`, 1),
        styleId: filledStringAt(entry.styleId, `${path}.styleId`),
    };
}

function readStyleRunFile(value: unknown, path: string): StyleRun {
    const run = recordAt(value, path);
    closedKeys(run, STYLE_RUN_KEYS, path);
    return {
        offset: integerAt(run.offset, `${path}.offset`, 0),
        length: integerAt(run.length, `${path}.length`, 1),
        styleId: filledStringAt(run.styleId, `${path}.styleId`),
    };
}

function readInsertedFile(value: unknown, path: string): InsertedObject {
    const object = recordAt(value, path);
    closedKeys(object, INSERTED_KEYS, path);
    const anchorValue = arrayAt(object.anchor, `${path}.anchor`);
    if (anchorValue.length !== 2) {
        fail(`${path}.anchor`, 'is not an [offset, length] pair');
    }
    const anchor = {
        offset: integerAt(anchorValue[0], `${path}.anchor[0]`, 0),
        length: integerAt(anchorValue[1], `${path}.anchor[1]`, 0),
    };
    const content =
        object.content === undefined || object.content === null
            ? null
            : readContent(object.content, `${path}.content`);
    const time =
        object.time === undefined
            ? undefined
            : readSpanTuple(object.time, `${path}.time`);
    return {
        id: filledStringAt(object.id, `${path}.id`),
        kind: filledStringAt(object.kind, `${path}.kind`),
        anchor,
        content,
        ...(time === undefined ? {} : { time }),
    };
}

function readContent(value: unknown, path: string): InsertContent {
    const content = recordAt(value, path);
    const type = stringAt(content.type, `${path}.type`);
    if (type === 'text') {
        closedKeys(content, TEXT_CONTENT_KEYS, path);
        const lines = arrayAt(content.lines, `${path}.lines`).map(
            (line, index) => stringAt(line, `${path}.lines[${index}]`),
        );
        if (lines.length === 0) {
            fail(`${path}.lines`, 'is empty');
        }
        const text: TextContent =
            content.styleId === undefined
                ? { type: 'text', lines }
                : {
                      type: 'text',
                      lines,
                      styleId: stringAt(content.styleId, `${path}.styleId`),
                  };
        return text;
    }
    if (type === 'image') {
        closedKeys(content, IMAGE_CONTENT_KEYS, path);
        const image: ImageContent = {
            type: 'image',
            src: stringAt(content.src, `${path}.src`),
            ...(content.wipedSrc === undefined
                ? {}
                : {
                      wipedSrc:
                          content.wipedSrc === null
                              ? null
                              : stringAt(content.wipedSrc, `${path}.wipedSrc`),
                  }),
            ...(content.scale === undefined
                ? {}
                : {
                      scale:
                          content.scale === null
                              ? null
                              : readScale(content.scale, `${path}.scale`),
                  }),
        };
        return image;
    }
    return fail(`${path}.type`, `is not "text" or "image"`);
}

function readScale(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        fail(path, 'is not a positive number');
    }
    return value;
}

function readSpanTuple(
    value: unknown,
    path: string,
): { readonly start: number; readonly duration: number } {
    const span = arrayAt(value, path);
    if (span.length !== 2) {
        fail(path, 'is not a [start, duration] pair');
    }
    return {
        start: integerAt(span[0], `${path}[0]`, -2147483648),
        duration: integerAt(span[1], `${path}[1]`, 0),
    };
}

function readAnimations(value: unknown): readonly unknown[] {
    if (value === undefined) {
        return NO_ANIMATIONS;
    }
    return arrayAt(value, 'animations');
}

/**
 * Validate a parsed project value and build the document.
 *
 * Every rejection is `invalid-project-file` with the offending path in the
 * message. The per-line rules are not re-implemented here: the overlay goes
 * through `overlayProblem`, so one file cannot be sound under the reader and
 * unsound under the API.
 */
export function projectToLyrics(value: unknown): ProjectRead {
    let document = recordAt(value, '');
    const format = document.format;
    if (format !== PROJECT_FORMAT) {
        fail('format', `is not "${PROJECT_FORMAT}"`);
    }
    const version = document.version;
    if (
        typeof version !== 'number' ||
        !Number.isSafeInteger(version) ||
        version < 1
    ) {
        fail('version', 'is not a positive integer');
    }
    if (version > PROJECT_VERSION) {
        fail(
            'version',
            `was written by a newer version (${version} > ${PROJECT_VERSION})`,
        );
    }
    for (let step = version; step < PROJECT_VERSION; step += 1) {
        const migrate = MIGRATIONS[step];
        if (migrate === undefined) {
            fail('version', `has no migration from ${step} to ${step + 1}`);
        }
        document = migrate(document);
    }
    closedKeys(document, PROJECT_KEYS, '');

    const lyrics = readLyricsBlock(document.lyrics);
    const styleBook = readStyleBook(document.styleBook);
    const overlays = readOverlays(document.overlay, lyrics.lines);
    const animations = readAnimations(document.animations);

    // One id, one object, one document. `overlayProblem` cannot see across
    // lines, so the rule lives here, where the whole file is in hand.
    const ids = new Set<string>();
    overlays.forEach((overlay, index) => {
        overlay.inserted.forEach((object, objectIndex) => {
            if (ids.has(object.id)) {
                fail(
                    `overlay[${index}].inserted[${objectIndex}]`,
                    `inserted object id "${object.id}" appears twice`,
                );
            }
            ids.add(object.id);
        });
    });

    const issues: ProjectIssue[] = [];
    const reported = new Set<string>();
    // Both a run and the text of an inserted block name a style id: the block
    // paints itself, so an id no def answers is the same orphan a run would be.
    // One report per id, whichever layer named it first.
    const reportStyle = (styleId: string): void => {
        if (Object.hasOwn(styleBook.defs, styleId)) {
            return;
        }
        if (reported.has(styleId)) {
            return;
        }
        reported.add(styleId);
        issues.push({ code: 'style-orphan', styleId });
    };
    for (const overlay of overlays) {
        for (const run of overlay.styles) {
            reportStyle(run.styleId);
        }
        for (const object of overlay.inserted) {
            const content = object.content;
            if (content === null || content.type !== 'text') {
                continue;
            }
            if (content.styleId !== undefined) {
                reportStyle(content.styleId);
            }
        }
    }

    return {
        lyrics: {
            meta: lyrics.meta,
            lines: lyrics.lines.map((line, index) =>
                rebuild(line, { overlay: overlays[index] }),
            ),
            styleBook,
            animations,
        },
        issues,
    };
}

/** The document as the shape that goes to disk. */
export function lyricsToProject(lyrics: Lyrics): ProjectFile {
    // The book goes straight into the file, so a parent that does not resolve
    // has to be refused here: the alternative is a document this package can
    // write and then never read back.
    assertStyleBook(lyrics.styleBook);
    const defs = writeDefs(lyrics.styleBook);
    const overlay = lyrics.lines.map(writeOverlayEntry);
    return {
        format: PROJECT_FORMAT,
        version: PROJECT_VERSION,
        lyrics: lyricsToExport(lyrics),
        ...(Object.keys(defs).length === 0 ? {} : { styleBook: { defs } }),
        ...(overlay.length === 0 ? {} : { overlay }),
        ...(lyrics.animations.length === 0
            ? {}
            : { animations: lyrics.animations }),
    };
}

/**
 * The content as it goes to disk: object keys sorted, arrays kept as they are.
 *
 * Two documents with equal content have to produce equal bytes even though
 * their records were built in different orders, which is the same promise the
 * rest of the writer keeps by sorting ids, style runs and inserted objects.
 */
function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalValue(entry));
    }
    if (typeof value === 'object' && value !== null) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonicalValue((value as Record<string, unknown>)[key]);
        }
        return out;
    }
    return value;
}

function writeDefs(book: StyleBook): Record<string, StyleDefFile> {
    const defs: Record<string, StyleDefFile> = {};
    for (const id of styleIds(book)) {
        const def = book.defs[id];
        if (def === undefined) {
            continue;
        }
        const content = canonicalValue(def.content) as StyleContent;
        const space = styleSpace(def);
        const file: StyleDefFile = {
            ...(def.basedOn === null ? {} : { basedOn: def.basedOn }),
            ...(space === 'character' ? {} : { space }),
            ...(Object.keys(content).length === 0 ? {} : { content }),
        };
        Object.defineProperty(defs, id, {
            value: file,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    return defs;
}

function writeOverlayEntry(line: LyricsLine): OverlayEntryFile {
    const overlay = overlayOf(line);
    assertOverlay(overlay, overlayContextOf(line));
    const styles = mergeAdjacentStyleRuns(overlay.styles).map(writeStyleRun);
    const inserted = overlay.inserted
        .slice()
        .sort((left, right) => left.anchor.offset - right.anchor.offset)
        .map(writeInserted);
    const blocks = overlay.blocks.map(writeBlockStyle);
    const runStyles = overlay.runStyles.map(writeRunStyle);
    const annotations = overlay.annotations.map(writeAnnotation);
    if (
        styles.length === 0 &&
        inserted.length === 0 &&
        blocks.length === 0 &&
        runStyles.length === 0 &&
        annotations.length === 0
    ) {
        return {};
    }
    return {
        ...(styles.length === 0 ? {} : { styles }),
        ...(inserted.length === 0 ? {} : { inserted }),
        ...(blocks.length === 0 ? {} : { blocks }),
        ...(runStyles.length === 0 ? {} : { runStyles }),
        ...(annotations.length === 0 ? {} : { annotations }),
    };
}

function writeBlockStyle(entry: BlockStyleRun): BlockStyleFile {
    return { from: entry.from, styleId: entry.styleId };
}

function writeRunStyle(entry: RunStyleRun): RunStyleFile {
    return { group: entry.group, offset: entry.offset, styleId: entry.styleId };
}

function writeAnnotation(entry: AnnotationStyleRun): AnnotationStyleFile {
    return {
        group: entry.group,
        runOffset: entry.runOffset,
        offset: entry.offset,
        length: entry.length,
        styleId: entry.styleId,
    };
}

function writeStyleRun(run: StyleRun): StyleRunFile {
    return { offset: run.offset, length: run.length, styleId: run.styleId };
}

function writeInserted(object: InsertedObject): InsertedObjectFile {
    return {
        id: object.id,
        kind: object.kind,
        anchor: [object.anchor.offset, object.anchor.length],
        ...(object.content === null
            ? {}
            : { content: writeContent(object.content) }),
        ...(object.time === undefined
            ? {}
            : { time: [object.time.start, object.time.duration] }),
    };
}

function writeContent(content: InsertContent): InsertContentFile {
    if (content.type === 'text') {
        return {
            type: 'text',
            lines: content.lines,
            ...(content.styleId === undefined
                ? {}
                : { styleId: content.styleId }),
        };
    }
    return {
        type: 'image',
        src: content.src,
        ...(content.wipedSrc === undefined
            ? {}
            : { wipedSrc: content.wipedSrc }),
        ...(content.scale === undefined ? {} : { scale: content.scale }),
    };
}
