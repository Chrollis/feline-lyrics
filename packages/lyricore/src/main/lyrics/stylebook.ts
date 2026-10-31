import { LyricoreError } from '../errors.js';

import {
    contentProblem,
    defaultContent,
    isStyleSpace,
    mergeContent,
    type StyleContent,
    type StyleSpace,
} from './stylecontent.js';

export { STYLE_SPACES, isStyleSpace } from './stylecontent.js';
export type { StyleSpace } from './stylecontent.js';

/**
 * One style definition: an optional parent, the space it belongs to and the
 * content it paints with.
 *
 * The content is a partial value of one space (see `stylecontent.ts`): a field
 * it carries replaces the inherited one whole, a field it omits is inherited.
 * The key set is closed per space, so a typo is refused at write time instead
 * of reaching a renderer that would silently ignore it.
 */
export interface StyleDef {
    /** The style this one inherits from, or null for a root definition. */
    readonly basedOn: string | null;
    /** Which kind of style this is. Absent means 'character'. */
    readonly space?: StyleSpace;
    readonly content: StyleContent;
}

/** The space a definition belongs to. An absent field means `'character'`. */
export function styleSpace(def: StyleDef): StyleSpace {
    return def.space ?? 'character';
}

/** Every definition a document may name, keyed by style id. */
export interface StyleBook {
    readonly defs: Readonly<Record<string, StyleDef>>;
}

/** The id grammar shared by the book keys and `StyleRun.styleId`. */
export const STYLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** How deep an inheritance chain may go before it is called a mistake. */
const MAX_DEPTH = 32;

const EMPTY_BOOK: StyleBook = Object.freeze({
    defs: Object.freeze({} as Record<string, StyleDef>),
});

/** The book every document starts with. One frozen value, so `===` works. */
export function emptyStyleBook(): StyleBook {
    return EMPTY_BOOK;
}

/** The ids in the book, sorted, which is also the canonical write order. */
export function styleIds(book: StyleBook): readonly string[] {
    return Object.keys(book.defs).sort();
}

/**
 * The definition under `id`, or null.
 *
 * `Object.hasOwn` rather than a truthiness test: an id may be `constructor` or
 * `toString`, and inherited names must never resolve to a definition
 * (the same stance `putGroup` takes for group names).
 */
export function styleDefAt(book: StyleBook, id: string): StyleDef | null {
    return Object.hasOwn(book.defs, id) ? book.defs[id] : null;
}

/** How many definitions sit between `id` and the root: 0, or -1 when unknown. */
export function styleDepth(book: StyleBook, id: string): number {
    if (!Object.hasOwn(book.defs, id)) {
        return -1;
    }
    try {
        return styleChain(book, id).length - 1;
    } catch {
        return -1;
    }
}

/** Every definition that names `id` as its parent, sorted. */
export function styleInheritors(
    book: StyleBook,
    id: string,
): readonly string[] {
    return styleIds(book).filter(
        (other) => styleDefAt(book, other)?.basedOn === id,
    );
}

/**
 * The properties `id` ends up with, parents first and the child last.
 *
 * Null means the id is not in this book - a query, not a failure. A chain that
 * loops or runs away throws instead: rendering unstyled is the worse outcome,
 * and a cycle is a bug worth stopping on.
 */
export function resolveStyle(book: StyleBook, id: string): StyleContent | null {
    if (!Object.hasOwn(book.defs, id)) {
        return null;
    }
    let content = defaultContent(styleSpace(book.defs[id]));
    for (const ancestor of styleChain(book, id)) {
        content = mergeContent(content, book.defs[ancestor].content);
    }
    // A shallow freeze would leave every object inside the content shared with
    // the definition, so a caller could paint one word by mutating what it was
    // handed. The deep copy also severs that link.
    return freezeContent(content) as StyleContent;
}

/**
 * Add or replace a definition, returning the book itself when nothing changed.
 *
 * The parent must already exist: a dangling `basedOn` is rejected here and by
 * `styleBookProblem`, never silently dropped. Writes go through
 * `Object.defineProperty` because a plain assignment would lose an id spelled
 * `__proto__`, the bug `putGroup` was written to avoid.
 */
export function withStyle(
    book: StyleBook,
    id: string,
    def: StyleDef,
): StyleBook {
    if (!STYLE_ID_PATTERN.test(id)) {
        throw new LyricoreError(
            'invalid-style-def',
            `style id ${JSON.stringify(id)} is not 1-32 of A-Z a-z 0-9 _ -`,
            { expected: 'a style id', actual: id },
        );
    }
    const declared: unknown = def.space;
    if (declared !== undefined && !isStyleSpace(declared)) {
        throw new LyricoreError(
            'invalid-style-def',
            `style ${JSON.stringify(id)} has the space ${JSON.stringify(declared)}, which is not ${describeSpaces()}`,
            { expected: 'a style space', actual: JSON.stringify(declared) },
        );
    }
    if (def.basedOn !== null) {
        if (!STYLE_ID_PATTERN.test(def.basedOn)) {
            throw new LyricoreError(
                'invalid-style-def',
                `style ${JSON.stringify(id)} inherits from ${JSON.stringify(def.basedOn)}, which is not a style id`,
                { expected: 'a style id', actual: def.basedOn },
            );
        }
        if (def.basedOn === id) {
            throw new LyricoreError(
                'invalid-style-def',
                `style ${JSON.stringify(id)} inherits from itself`,
                { expected: 'a parent other than itself', actual: id },
            );
        }
        if (!Object.hasOwn(book.defs, def.basedOn)) {
            throw new LyricoreError(
                'invalid-style-def',
                `style ${JSON.stringify(id)} inherits from the unknown style ${JSON.stringify(def.basedOn)}`,
                {
                    expected: 'a parent already in the book',
                    actual: def.basedOn,
                },
            );
        }
        const parent = book.defs[def.basedOn];
        if (styleSpace(parent) !== styleSpace(def)) {
            throw new LyricoreError(
                'invalid-style-def',
                `the ${styleSpace(def)} style ${JSON.stringify(id)} inherits from the ${styleSpace(parent)} style ${JSON.stringify(def.basedOn)}`,
                { expected: 'a parent in the same space', actual: def.basedOn },
            );
        }
    }
    const problem = styleContentProblem(id, def);
    if (problem !== null) {
        throw new LyricoreError('invalid-style-def', problem, {
            expected: 'a definition whose content fits its space',
            actual: id,
        });
    }
    const current = styleDefAt(book, id);
    if (
        current !== null &&
        current.basedOn === def.basedOn &&
        styleSpace(current) === styleSpace(def) &&
        sameContent(current.content, def.content)
    ) {
        return book;
    }
    const next: Record<string, StyleDef> = { ...book.defs };
    defineStyle(next, id, freezeStyleDef(def));
    // A new edge is the only way a cycle can appear, and `styleChain` is the
    // one place that knows how to find one: run it now so the write is refused
    // here, not by `assertStyleBook` on the next load.
    styleChain({ defs: next }, id);
    return Object.freeze({ defs: Object.freeze(next) });
}

/**
 * Drop a definition. Refused while another style still inherits from it, with
 * the dependents named: re-parenting them silently would change what they paint.
 */
export function removeStyle(book: StyleBook, id: string): StyleBook {
    if (!Object.hasOwn(book.defs, id)) {
        return book;
    }
    const dependents = styleInheritors(book, id);
    if (dependents.length > 0) {
        const named = dependents
            .map((other) => JSON.stringify(other))
            .join(', ');
        throw new LyricoreError(
            'invalid-style-book',
            `style ${JSON.stringify(id)} is inherited by ${named}`,
            { expected: 'a style nothing inherits from', actual: id },
        );
    }
    const next: Record<string, StyleDef> = { ...book.defs };
    delete next[id];
    return Object.freeze({ defs: Object.freeze(next) });
}

/** The first thing wrong with one definition, or null. */
export function styleDefProblem(book: StyleBook, id: string): string | null {
    if (!STYLE_ID_PATTERN.test(id)) {
        return `style id ${JSON.stringify(id)} is not 1-32 of A-Z a-z 0-9 _ -`;
    }
    const def = styleDefAt(book, id);
    if (def === null) {
        return `style ${JSON.stringify(id)} has no definition`;
    }
    const declared: unknown = def.space;
    if (declared !== undefined && !isStyleSpace(declared)) {
        return `style ${JSON.stringify(id)} has the space ${JSON.stringify(declared)}, which is not ${describeSpaces()}`;
    }
    if (def.basedOn !== null) {
        if (!STYLE_ID_PATTERN.test(def.basedOn)) {
            return `style ${JSON.stringify(id)} inherits from ${JSON.stringify(def.basedOn)}, which is not a style id`;
        }
        if (def.basedOn === id) {
            return `style ${JSON.stringify(id)} inherits from itself`;
        }
        if (!Object.hasOwn(book.defs, def.basedOn)) {
            return `style ${JSON.stringify(id)} inherits from the unknown style ${JSON.stringify(def.basedOn)}`;
        }
        const parent = styleDefAt(book, def.basedOn);
        if (parent !== null && styleSpace(parent) !== styleSpace(def)) {
            return `the ${styleSpace(def)} style ${JSON.stringify(id)} inherits from the ${styleSpace(parent)} style ${JSON.stringify(def.basedOn)}`;
        }
    }
    return styleContentProblem(id, def);
}

/**
 * The first thing wrong with the book, or null.
 *
 * Never throws, so `isValidStyleBook` can be a plain comparison; the throwing
 * form is `assertStyleBook`, which carries the code.
 */
export function styleBookProblem(book: StyleBook): string | null {
    if (!isRecord(book) || !isRecord(book.defs)) {
        return 'a style book is an object with a "defs" record';
    }
    for (const id of Object.keys(book.defs)) {
        const problem = styleDefProblem(book, id);
        if (problem !== null) {
            return problem;
        }
        try {
            styleChain(book, id);
        } catch (error) {
            return error instanceof LyricoreError
                ? error.message
                : `style ${JSON.stringify(id)} has an unresolvable chain`;
        }
    }
    return null;
}

export function isValidStyleBook(book: StyleBook): boolean {
    return styleBookProblem(book) === null;
}

export function assertStyleBook(book: StyleBook): StyleBook {
    const problem = styleBookProblem(book);
    if (problem !== null) {
        throw new LyricoreError('invalid-style-book', problem, {
            expected: 'a style book whose ids, parents and content resolve',
            actual: problem,
        });
    }
    return book;
}

/** `id` first, then its parent, up to the root; throws on a loop or too deep. */
function styleChain(book: StyleBook, id: string): readonly string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | null = id;
    while (current !== null) {
        if (seen.has(current)) {
            throw new LyricoreError(
                'invalid-style-book',
                `style ${JSON.stringify(id)} inherits from itself through ${JSON.stringify(current)}`,
                { expected: 'a chain that ends', actual: current },
            );
        }
        seen.add(current);
        const def = styleDefAt(book, current);
        if (def === null) {
            throw new LyricoreError(
                'invalid-style-book',
                `style ${JSON.stringify(id)} inherits from the unknown style ${JSON.stringify(current)}`,
                { expected: 'a parent in the book', actual: current },
            );
        }
        chain.push(current);
        // The chain holds the id itself plus one entry per link, so depth 32
        // (32 parents) is 33 nodes and stays legal; 34 nodes is depth 33.
        if (chain.length > MAX_DEPTH + 1) {
            throw new LyricoreError(
                'invalid-style-book',
                `style ${JSON.stringify(id)} inherits through more than ${MAX_DEPTH} definitions`,
                {
                    expected: `at most ${MAX_DEPTH} links`,
                    actual: String(chain.length - 1),
                },
            );
        }
        current = def.basedOn;
    }
    return chain.reverse();
}

function styleContentProblem(id: string, def: StyleDef): string | null {
    const space = styleSpace(def);
    if (!isStyleSpace(space)) {
        return `style ${JSON.stringify(id)} has the space ${JSON.stringify(space)}, which is not ${describeSpaces()}`;
    }
    const problem = contentProblem(space, def.content);
    return problem === null ? null : `style ${JSON.stringify(id)}: ${problem}`;
}

/**
 * Structural equality over the JSON values a content is made of.
 *
 * The identity fast path needs value equality, not reference equality: a caller
 * builds a fresh object every time, and writing the same style again should not
 * grow the document.
 */
function sameContent(left: unknown, right: unknown): boolean {
    if (left === right) {
        return true;
    }
    if (Array.isArray(left)) {
        if (!Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, index) => sameContent(value, right[index]));
    }
    if (isRecord(left)) {
        if (!isRecord(right)) {
            return false;
        }
        const keys = Object.keys(left);
        if (keys.length !== Object.keys(right).length) {
            return false;
        }
        return keys.every(
            (key) =>
                Object.hasOwn(right, key) && sameContent(left[key], right[key]),
        );
    }
    return false;
}

/**
 * A frozen deep copy of a content.
 *
 * The copy matters: the caller keeps its literal, and the book must not change
 * under it. The keys are already validated against the space's closed set, so a
 * plain assignment cannot walk into `__proto__` here.
 */
function freezeContent(value: unknown): unknown {
    if (Array.isArray(value)) {
        return Object.freeze(value.map((entry) => freezeContent(entry)));
    }
    if (isRecord(value)) {
        const copy: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            copy[key] = freezeContent(value[key]);
        }
        return Object.freeze(copy);
    }
    return value;
}

function freezeStyleDef(def: StyleDef): StyleDef {
    // `'character'` is the absent value, so it is not stored: one definition
    // has one shape in memory and the writer has nothing to normalise.
    const space = styleSpace(def);
    return Object.freeze({
        basedOn: def.basedOn,
        ...(space === 'character' ? {} : { space }),
        content: freezeContent(def.content) as StyleContent,
    });
}

/** The three space names, for an error message. */
function describeSpaces(): string {
    return "'character', 'run' or 'paragraph'";
}

function defineStyle(
    target: Record<string, StyleDef>,
    id: string,
    def: StyleDef,
): void {
    Object.defineProperty(target, id, {
        value: def,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
