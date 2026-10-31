export type { LyricoreErrorCode, LyricoreErrorContext } from './errors.js';
export { LyricoreError } from './errors.js';
export type {
    TimeLevel,
    TimeParts,
    TimePartsInput,
    TimeSpan,
    TimeUnit,
} from './lyrics/time.js';
export {
    endOf,
    isTime,
    isValidSpan,
    joinTime,
    MS_PER_D,
    MS_PER_H,
    MS_PER_M,
    MS_PER_S,
    splitTime,
    TIME_MAX,
    TIME_MIN,
} from './lyrics/time.js';
export type { CharCell, CharStream } from './lyrics/char.js';
export {
    assertGraphemeCluster,
    isGraphemeCluster,
    isLineStream,
    isSegStream,
    isValidCell,
    streamToText,
    textToStream,
} from './lyrics/char.js';
export type {
    CheckPoint,
    CheckType,
    SegPiece,
    SegRun,
} from './lyrics/seg-run.js';
export {
    isTerminalRun,
    isValidCheckPoint,
    isValidSegPiece,
    isValidSegRun,
    joinPieces,
    terminalRun,
} from './lyrics/seg-run.js';
export type {
    CellSpan,
    ImageContent,
    InsertContent,
    InsertedObject,
    LineOverlay,
    StyleRun,
    TextContent,
} from './lyrics/overlay.js';
export { NO_OVERLAY, overlayProblem } from './lyrics/overlay.js';
export type { CheckSlot, LyricsLine } from './lyrics/line.js';
export {
    assertLyricsLine,
    assertTerminalRuns,
    emptyLyricsLine,
    isValidLyricsLine,
    lyricsLineToText,
    overlayOf,
    runAt,
    spliceGroups,
    spliceLine,
    textToLyricsLine,
    withCheck,
    withGroup,
    withOverlay,
    withPiece,
    withPieceText,
    withRun,
} from './lyrics/line.js';
export type { CheckTarget } from './lyrics/interpolate.js';
export {
    alignPreviousEnd,
    clearCheck,
    editLineText,
    fillFromCheck,
    recordCheck,
    refillAll,
    refillGroup,
    TAIL_MS,
} from './lyrics/interpolate.js';
export {
    insertLine,
    mergeLines,
    removeLine,
    splitLine,
} from './lyrics/structure.js';
export type { LyricsMeta } from './lyrics/meta.js';
export { emptyMeta, isValidMeta } from './lyrics/meta.js';
export type { Lyrics } from './lyrics/lyrics.js';
export {
    NO_ANIMATIONS,
    assertLyrics,
    isValidLyrics,
    lyricsOf,
    lyricsToText,
    textToLyrics,
    withMeta,
} from './lyrics/lyrics.js';
export type { StyleBook, StyleDef } from './lyrics/stylebook.js';
export {
    STYLE_ID_PATTERN,
    assertStyleBook,
    emptyStyleBook,
    isValidStyleBook,
    removeStyle,
    resolveStyle,
    styleBookProblem,
    styleDefAt,
    styleDefProblem,
    styleDepth,
    styleIds,
    styleInheritors,
    withStyle,
} from './lyrics/stylebook.js';
export { lineSpan, pieceStart, runStart } from './lyrics/views.js';
export type {
    CellTimeFile,
    CheckFile,
    LineFile,
    LyricsFile,
    MetaFile,
    PieceFile,
    RunFile,
    SpanFile,
} from './lyrics/file.js';
export {
    exportToLyrics,
    lyricsToExport,
    lyricsToExportJson,
    readExportJson,
} from './lyrics/file.js';
export type { Loss, LossCode, LossCollector } from './io/loss.js';
export { newLosses } from './io/loss.js';
export type { Exported, Imported } from './io/plain.js';
export { exportPlainText, importPlainText } from './io/plain.js';
export type { RubyEntry } from './io/ruby.js';
export {
    applyRuby,
    formatOffset,
    formatRuby,
    joinReading,
    parseRubyLine,
    splitReading,
} from './io/ruby.js';
export type { ScannedLine, TagChunk } from './io/tags.js';
export { formatTag, parseTag, scanTags } from './io/tags.js';
export type { Header } from './io/headers.js';
export {
    formatHeaders,
    formatLrcHeaders,
    parseHeader,
    withHeader,
} from './io/headers.js';
export { exportLrc, importLrc } from './io/lrc.js';
export {
    DEFAULT_GROUP,
    exportTagText,
    importTagText,
    RUBY_GROUP,
} from './io/tagtext.js';
export type { TagExportOptions, TagImportOptions } from './io/tagtext.js';
export type {
    DecodedText,
    LyricEncoding,
    TextLine,
    WritableEncoding,
} from './io/text.js';
export {
    decodeText,
    encodeText,
    ensureTrailingBreak,
    joinLines,
    splitLines,
} from './io/text.js';
export type {
    ImageContentFile,
    InsertContentFile,
    InsertedObjectFile,
    OverlayEntryFile,
    ProjectFile,
    ProjectIssue,
    ProjectRead,
    StyleBookFile,
    StyleDefFile,
    StyleRunFile,
    TextContentFile,
} from './project/index.js';
export {
    PROJECT_FORMAT,
    PROJECT_VERSION,
    lyricsToProject,
    lyricsToProjectJson,
    projectToJson,
    projectToLyrics,
    readProjectJson,
} from './project/index.js';
