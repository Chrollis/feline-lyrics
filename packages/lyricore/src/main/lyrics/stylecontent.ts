/**
 * What a style definition says, per space.
 *
 * A definition holds a partial content: a field that is absent is inherited
 * from the parent definition (or from the built-in default), and a field that
 * is present replaces the inherited value WHOLE. Objects are never merged field
 * by field, so the object inside a content is a complete statement - which is
 * also why the built-in default is complete.
 *
 * Three levels decide what a field means:
 *
 * 1. absent - inherit;
 * 2. `null` - explicitly nothing, allowed only where "nothing" is a real
 *    visual state (`outline`, `shadow`);
 * 3. inside an object - every field is required, no null, no partial object.
 *
 * The character space is the karaoke one: `fill.active` is the fill a cell
 * shows once it has been sung, `fill.normal` the fill before that, and `wipe`
 * says how the boundary between the two travels through the cell. A cell of
 * the line is one `CharCell`, so a sweep is per cell, in the cell's own time
 * span.
 */

import { LyricoreError } from '../errors.js';

/**
 * Which kind of style a definition describes.
 *
 * The three kinds are carried by different coordinate spaces - base cells and a
 * run's text for characters, the run itself for its layout, a paragraph block
 * for its layout - so the id alone cannot say whether `chorus` is a font or a
 * ruby placement.
 */
export type StyleSpace = 'character' | 'run' | 'paragraph';

/** The three spaces, in the order a document lists them. */
export const STYLE_SPACES: readonly StyleSpace[] = [
    'character',
    'run',
    'paragraph',
];

/** Whether `value` names one of the three spaces. */
export function isStyleSpace(value: unknown): value is StyleSpace {
    return value === 'character' || value === 'run' || value === 'paragraph';
}

/** A colour: `#rrggbb`, or `#rrggbbaa` when it carries alpha. */
export type Color = string;

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** One stop of a gradient: where on the ramp, and which colour. */
export interface FillStop {
    readonly position: number;
    readonly color: Color;
}

/**
 * How an area is painted.
 *
 * A gradient with `smooth: false` is the reference's linear SEGMENTS: the
 * stops are hard bands with no interpolation between them. One shape carries
 * both so the file has one fill object, not two.
 *
 * `image` is deliberately absent: it needs the resource system, which this
 * package does not have yet, and a fill that silently degrades is worse than a
 * refusal that names the reason.
 */
export type Fill =
    | { readonly kind: 'solid'; readonly color: Color }
    | {
          readonly kind: 'gradient';
          readonly angleDeg: number;
          readonly stops: readonly FillStop[];
          readonly smooth: boolean;
      };

/** The fill of a cell before and after it is sung. */
export interface DualFill {
    readonly normal: Fill;
    /** The sung fill. Absent means the cell keeps `normal` throughout. */
    readonly active?: Fill;
}

/** Which way the boundary between the two fills travels. */
export type WipeDirection = 'ltr' | 'rtl' | 'ttb' | 'btt' | 'none';

/** How the boundary moves within a cell: evenly, or eased. */
export type WipeTransition = 'linear' | 'smooth';

/**
 * How a cell changes from `normal` to `active`.
 *
 * `direction: 'none'` is the ASS `\k` behaviour: at the cell's start it flips
 * whole, with no boundary at all. `ltr` is `\kf`: the active area grows in from
 * the left edge over the cell's own time span. `featherPx` softens the
 * boundary; 0 is a hard edge.
 */
export interface Wipe {
    readonly direction: WipeDirection;
    readonly transition: WipeTransition;
    readonly featherPx: number;
}

/** The font stacks a renderer falls back through. Empty means "no preference". */
export interface FontFamilies {
    readonly cjk: readonly string[];
    readonly latin: readonly string[];
}

/** A border around the glyphs, which has its own two states. */
export interface Outline {
    readonly fill: DualFill;
    readonly widthPx: number;
    readonly blurPx: number;
}

/** A copy of the glyphs behind them, which has its own two states. */
export interface Shadow {
    readonly fill: DualFill;
    readonly offsetXPx: number;
    readonly offsetYPx: number;
    readonly blurPx: number;
}

/**
 * The character space: how a cell and the text inside a run are painted.
 *
 * `normal` is what a cell shows before it is sung, which is ASS's secondary
 * colour; `active` is what it shows afterwards, ASS's primary colour.
 */
export interface CharacterContent {
    readonly font?: FontFamilies;
    readonly sizePx?: number;
    readonly weight?: number;
    readonly italic?: boolean;
    readonly letterSpacingPx?: number;
    readonly baselineShiftPx?: number;
    readonly fill?: DualFill;
    readonly wipe?: Wipe;
    /** `null` removes an inherited outline; absent inherits one. */
    readonly outline?: Outline | null;
    /** `null` removes an inherited shadow; absent inherits one. */
    readonly shadow?: Shadow | null;
}

/** The run space: where a ruby run sits relative to the text it annotates. */
export interface RunContent {
    readonly position?: 'above' | 'below';
    readonly align?: 'left' | 'center' | 'right';
    readonly distancePx?: number;
}

/** The paragraph space: how a display block is laid out. */
export interface ParagraphContent {
    readonly align?: 'left' | 'center' | 'right' | 'justify';
    readonly direction?: 'ltr' | 'rtl';
    readonly leftIndentPx?: number;
    readonly rightIndentPx?: number;
    readonly lineHeight?: number;
    readonly verticalAlign?: 'top' | 'middle' | 'bottom';
    readonly spacingBeforePx?: number;
    readonly spacingAfterPx?: number;
}

/** The content of one definition, told apart by the space it belongs to. */
export type StyleContent = CharacterContent | RunContent | ParagraphContent;

/** The keys each space accepts, sorted. This set is closed. */
export const CONTENT_KEYS: Readonly<Record<StyleSpace, readonly string[]>> = {
    character: [
        'baselineShiftPx',
        'fill',
        'font',
        'italic',
        'letterSpacingPx',
        'outline',
        'shadow',
        'sizePx',
        'weight',
        'wipe',
    ],
    run: ['align', 'distancePx', 'position'],
    paragraph: [
        'align',
        'direction',
        'leftIndentPx',
        'lineHeight',
        'rightIndentPx',
        'spacingAfterPx',
        'spacingBeforePx',
        'verticalAlign',
    ],
};

/** The keys `space` accepts. */
export function contentKeys(space: StyleSpace): readonly string[] {
    return CONTENT_KEYS[space];
}

/**
 * The complete content a definition starts from.
 *
 * Complete on purpose: a resolved style must be total, so nothing downstream
 * has to decide what an absent field means twice.
 */
const DEFAULT_CHARACTER: CharacterContent = Object.freeze({
    font: Object.freeze({ cjk: Object.freeze([]), latin: Object.freeze([]) }),
    sizePx: 48,
    weight: 400,
    italic: false,
    letterSpacingPx: 0,
    baselineShiftPx: 0,
    fill: Object.freeze({
        normal: Object.freeze({ kind: 'solid', color: '#ffffff' }),
    }),
    wipe: Object.freeze({
        direction: 'none',
        transition: 'linear',
        featherPx: 0,
    }),
    outline: null,
    shadow: null,
}) satisfies CharacterContent;

const DEFAULT_RUN: RunContent = Object.freeze({
    position: 'above',
    align: 'center',
    distancePx: 4,
}) satisfies RunContent;

const DEFAULT_PARAGRAPH: ParagraphContent = Object.freeze({
    align: 'center',
    direction: 'ltr',
    leftIndentPx: 0,
    rightIndentPx: 0,
    lineHeight: 1.2,
    verticalAlign: 'bottom',
    spacingBeforePx: 0,
    spacingAfterPx: 0,
}) satisfies ParagraphContent;

const DEFAULT_CONTENTS: Readonly<Record<StyleSpace, StyleContent>> = {
    character: DEFAULT_CHARACTER,
    run: DEFAULT_RUN,
    paragraph: DEFAULT_PARAGRAPH,
};

/** The complete content a definition of `space` starts from. */
export function defaultContent(space: StyleSpace): StyleContent {
    return DEFAULT_CONTENTS[space];
}

/**
 * `base` with every present field of `overlay` laid over it.
 *
 * Top-level only: an object present in `overlay` replaces the one in `base`,
 * it is not merged into it. `undefined` is "absent", never a value.
 */
export function mergeContent(
    base: StyleContent,
    overlay: StyleContent,
): StyleContent {
    const merged: Record<string, unknown> = { ...base };
    for (const key of Object.keys(overlay)) {
        const value = (overlay as Readonly<Record<string, unknown>>)[key];
        if (value !== undefined) {
            merged[key] = value;
        }
    }
    return merged as StyleContent;
}

/**
 * What is wrong with `value` as the content of `space`, or null.
 *
 * The message names the leaf - `fill.active.color: is not a colour` - and the
 * caller prefixes the path and the style id.
 */
export function contentProblem(
    space: StyleSpace,
    value: unknown,
): string | null {
    const record = asRecord(value);
    if (record === null) {
        return 'is not an object';
    }
    const allowed = CONTENT_KEYS[space];
    for (const key of Object.keys(record)) {
        if (!allowed.includes(key)) {
            return `${key}: is not a field of a ${space} style`;
        }
    }
    switch (space) {
        case 'character':
            return characterProblem(record);
        case 'run':
            return runProblem(record);
        case 'paragraph':
            return paragraphProblem(record);
    }
}

/** Whether `value` is a legal content for `space`. */
export function isValidContent(space: StyleSpace, value: unknown): boolean {
    return contentProblem(space, value) === null;
}

/** Throws unless `value` is a legal content for `space`. */
export function assertContent(space: StyleSpace, value: unknown): void {
    const problem = contentProblem(space, value);
    if (problem !== null) {
        throw new LyricoreError('invalid-style-def', problem, {
            expected: `a ${space} style content`,
            actual: problem,
        });
    }
}

function characterProblem(
    record: Readonly<Record<string, unknown>>,
): string | null {
    if (record.font !== undefined) {
        const font = asRecord(record.font);
        if (font === null) {
            return 'font: is not an object';
        }
        for (const key of Object.keys(font)) {
            if (key !== 'cjk' && key !== 'latin') {
                return `font.${key}: is not a field of a font`;
            }
        }
        for (const key of ['cjk', 'latin']) {
            if (font[key] === undefined) {
                return `font.${key}: is missing`;
            }
            const names = stringArray(font[key]);
            if (names === null) {
                return `font.${key}: is not an array of names`;
            }
        }
    }
    if (record.sizePx !== undefined && !isPositive(record.sizePx)) {
        return 'sizePx: is not a positive number';
    }
    if (record.weight !== undefined) {
        const weight = record.weight;
        if (
            typeof weight !== 'number' ||
            !Number.isInteger(weight) ||
            weight < 100 ||
            weight > 900
        ) {
            return 'weight: is not an integer from 100 to 900';
        }
    }
    if (record.italic !== undefined && typeof record.italic !== 'boolean') {
        return 'italic: is not true or false';
    }
    if (
        record.letterSpacingPx !== undefined &&
        !isFiniteNumber(record.letterSpacingPx)
    ) {
        return 'letterSpacingPx: is not a number';
    }
    if (
        record.baselineShiftPx !== undefined &&
        !isFiniteNumber(record.baselineShiftPx)
    ) {
        return 'baselineShiftPx: is not a number';
    }
    if (record.fill !== undefined) {
        const problem = dualFillProblem(record.fill, 'fill');
        if (problem !== null) {
            return problem;
        }
    }
    if (record.wipe !== undefined) {
        const problem = wipeProblem(record.wipe);
        if (problem !== null) {
            return problem;
        }
    }
    if (record.outline !== undefined && record.outline !== null) {
        const problem = decorationProblem(record.outline, 'outline', true);
        if (problem !== null) {
            return problem;
        }
    }
    if (record.shadow !== undefined && record.shadow !== null) {
        const problem = decorationProblem(record.shadow, 'shadow', false);
        if (problem !== null) {
            return problem;
        }
    }
    return null;
}

function runProblem(record: Readonly<Record<string, unknown>>): string | null {
    if (
        record.position !== undefined &&
        record.position !== 'above' &&
        record.position !== 'below'
    ) {
        return "position: is not 'above' or 'below'";
    }
    if (
        record.align !== undefined &&
        record.align !== 'left' &&
        record.align !== 'center' &&
        record.align !== 'right'
    ) {
        return "align: is not 'left', 'center' or 'right'";
    }
    if (record.distancePx !== undefined && !isNonNegative(record.distancePx)) {
        return 'distancePx: is not a number of 0 or more';
    }
    return null;
}

function paragraphProblem(
    record: Readonly<Record<string, unknown>>,
): string | null {
    if (
        record.align !== undefined &&
        record.align !== 'left' &&
        record.align !== 'center' &&
        record.align !== 'right' &&
        record.align !== 'justify'
    ) {
        return "align: is not 'left', 'center', 'right' or 'justify'";
    }
    if (
        record.direction !== undefined &&
        record.direction !== 'ltr' &&
        record.direction !== 'rtl'
    ) {
        return "direction: is not 'ltr' or 'rtl'";
    }
    for (const key of [
        'leftIndentPx',
        'rightIndentPx',
        'spacingBeforePx',
        'spacingAfterPx',
    ]) {
        if (record[key] !== undefined && !isNonNegative(record[key])) {
            return `${key}: is not a number of 0 or more`;
        }
    }
    if (record.lineHeight !== undefined && !isPositive(record.lineHeight)) {
        return 'lineHeight: is not a positive number';
    }
    if (
        record.verticalAlign !== undefined &&
        record.verticalAlign !== 'top' &&
        record.verticalAlign !== 'middle' &&
        record.verticalAlign !== 'bottom'
    ) {
        return "verticalAlign: is not 'top', 'middle' or 'bottom'";
    }
    return null;
}

function decorationProblem(
    value: unknown,
    name: 'outline' | 'shadow',
    isOutline: boolean,
): string | null {
    const record = asRecord(value);
    if (record === null) {
        return `${name}: is not an object or null`;
    }
    const allowed = isOutline
        ? ['fill', 'widthPx', 'blurPx']
        : ['fill', 'offsetXPx', 'offsetYPx', 'blurPx'];
    for (const key of Object.keys(record)) {
        if (!allowed.includes(key)) {
            return `${name}.${key}: is not a field of a ${name}`;
        }
    }
    if (record.fill === undefined) {
        return `${name}.fill: is missing`;
    }
    const fillProblem = dualFillProblem(record.fill, `${name}.fill`);
    if (fillProblem !== null) {
        return fillProblem;
    }
    if (isOutline) {
        if (!isPositive(record.widthPx)) {
            return `${name}.widthPx: is not a positive number`;
        }
    } else {
        if (!isFiniteNumber(record.offsetXPx)) {
            return `${name}.offsetXPx: is not a number`;
        }
        if (!isFiniteNumber(record.offsetYPx)) {
            return `${name}.offsetYPx: is not a number`;
        }
    }
    if (!isNonNegative(record.blurPx)) {
        return `${name}.blurPx: is not a number of 0 or more`;
    }
    return null;
}

function dualFillProblem(value: unknown, path: string): string | null {
    const record = asRecord(value);
    if (record === null) {
        return `${path}: is not an object`;
    }
    for (const key of Object.keys(record)) {
        if (key !== 'normal' && key !== 'active') {
            return `${path}.${key}: is not a field of a fill`;
        }
    }
    if (record.normal === undefined) {
        return `${path}.normal: is missing`;
    }
    const normalProblem = fillProblem(record.normal, `${path}.normal`);
    if (normalProblem !== null) {
        return normalProblem;
    }
    if (record.active !== undefined) {
        const activeProblem = fillProblem(record.active, `${path}.active`);
        if (activeProblem !== null) {
            return activeProblem;
        }
    }
    return null;
}

function fillProblem(value: unknown, path: string): string | null {
    const record = asRecord(value);
    if (record === null) {
        return `${path}: is not an object`;
    }
    const kind = record.kind;
    if (kind === 'image') {
        return `${path}.kind: image fills need the resource system, which this version does not have`;
    }
    if (kind === 'solid') {
        for (const key of Object.keys(record)) {
            if (key !== 'kind' && key !== 'color') {
                return `${path}.${key}: is not a field of a solid fill`;
            }
        }
        if (!isColor(record.color)) {
            return `${path}.color: is not a colour`;
        }
        return null;
    }
    if (kind === 'gradient') {
        for (const key of Object.keys(record)) {
            if (
                key !== 'kind' &&
                key !== 'angleDeg' &&
                key !== 'stops' &&
                key !== 'smooth'
            ) {
                return `${path}.${key}: is not a field of a gradient fill`;
            }
        }
        if (!isFiniteNumber(record.angleDeg)) {
            return `${path}.angleDeg: is not a number`;
        }
        if (typeof record.smooth !== 'boolean') {
            return `${path}.smooth: is not true or false`;
        }
        if (!Array.isArray(record.stops) || record.stops.length < 2) {
            return `${path}.stops: is not an array of two stops or more`;
        }
        let previous = -1;
        for (const [index, stop] of record.stops.entries()) {
            const at = `${path}.stops[${index}]`;
            const stopRecord = asRecord(stop);
            if (stopRecord === null) {
                return `${at}: is not an object`;
            }
            for (const key of Object.keys(stopRecord)) {
                if (key !== 'position' && key !== 'color') {
                    return `${at}.${key}: is not a field of a stop`;
                }
            }
            const position = stopRecord.position;
            if (
                typeof position !== 'number' ||
                !Number.isFinite(position) ||
                position < 0 ||
                position > 1
            ) {
                return `${at}.position: is not a number from 0 to 1`;
            }
            if (position <= previous) {
                return `${at}.position: is not past the stop before it`;
            }
            previous = position;
            if (!isColor(stopRecord.color)) {
                return `${at}.color: is not a colour`;
            }
        }
        return null;
    }
    return `${path}.kind: is not 'solid' or 'gradient'`;
}

function wipeProblem(value: unknown): string | null {
    const record = asRecord(value);
    if (record === null) {
        return 'wipe: is not an object';
    }
    for (const key of Object.keys(record)) {
        if (
            key !== 'direction' &&
            key !== 'transition' &&
            key !== 'featherPx'
        ) {
            return `wipe.${key}: is not a field of a wipe`;
        }
    }
    const direction = record.direction;
    if (
        direction !== 'ltr' &&
        direction !== 'rtl' &&
        direction !== 'ttb' &&
        direction !== 'btt' &&
        direction !== 'none'
    ) {
        return "wipe.direction: is not 'ltr', 'rtl', 'ttb', 'btt' or 'none'";
    }
    if (record.transition !== 'linear' && record.transition !== 'smooth') {
        return "wipe.transition: is not 'linear' or 'smooth'";
    }
    if (!isNonNegative(record.featherPx)) {
        return 'wipe.featherPx: is not a number of 0 or more';
    }
    return null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    return value as Readonly<Record<string, unknown>>;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isPositive(value: unknown): value is number {
    return isFiniteNumber(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0;
}

function isColor(value: unknown): value is Color {
    return typeof value === 'string' && COLOR_PATTERN.test(value);
}

function stringArray(value: unknown): readonly string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const names: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string' || entry === '') {
            return null;
        }
        names.push(entry);
    }
    return names;
}
