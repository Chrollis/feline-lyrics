import { LyricoreError } from '../errors.js';

/**
 * One style definition: an optional parent and a bag of opaque properties.
 *
 * The values are strings because lyricore owns no renderer and therefore has no
 * grammar to check them against. `color: '#ff0000'`, `weight: '700'` and
 * `scale: '0.75em'` are all just data here; a renderer decides what they mean.
 * The bag is open on purpose - adding a property must not touch this package -
 * while the key set is closed where it lives in a document, which is the same
 * split the lyric metadata uses.
 */
export interface StyleDef {
    /** The style this one inherits from, or null for a root definition. */
    readonly basedOn: string | null;
    readonly fields: Readonly<Record<string, string>>;
}

/** Every definition a document may name, keyed by style id. */
export interface StyleBook {
    readonly defs: Readonly<Record<string, StyleDef>>;
}

/** The id grammar shared by the book keys and `StyleRun.styleId`. */
export const STYLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** A property name: letters, digits, dash, underscore. Not a path, not CSS. */
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

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
export function resolveStyle(
    book: StyleBook,
    id: string,
): Readonly<Record<string, string>> | null {
    if (!Object.hasOwn(book.defs, id)) {
        return null;
    }
    const fields: Record<string, string> = {};
    for (const ancestor of styleChain(book, id)) {
        const def = book.defs[ancestor];
        for (const key of Object.keys(def.fields)) {
            const value = def.fields[key];
            if (value !== '') {
                fields[key] = value;
            }
        }
    }
    return Object.freeze(fields);
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
    }
    const problem = styleFieldsProblem(id, def);
    if (problem !== null) {
        throw new LyricoreError('invalid-style-def', problem, {
            expected: 'a definition with string fields',
            actual: id,
        });
    }
    const current = styleDefAt(book, id);
    if (
        current !== null &&
        current.basedOn === def.basedOn &&
        sameFields(current.fields, def.fields)
    ) {
        return book;
    }
    const next: Record<string, StyleDef> = { ...book.defs };
    defineStyle(next, id, freezeStyleDef(def));
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
    }
    return styleFieldsProblem(id, def);
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
            expected: 'a style book whose ids, parents and fields resolve',
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

function styleFieldsProblem(id: string, def: StyleDef): string | null {
    if (!isRecord(def.fields)) {
        return `style ${JSON.stringify(id)} has no fields record`;
    }
    for (const key of Object.keys(def.fields)) {
        if (!FIELD_PATTERN.test(key)) {
            return `style ${JSON.stringify(id)} has the field ${JSON.stringify(key)}, which is not a property name`;
        }
        const value = def.fields[key];
        if (typeof value !== 'string') {
            return `style ${JSON.stringify(id)} field ${JSON.stringify(key)} is not a string`;
        }
    }
    return null;
}

function sameFields(
    left: Readonly<Record<string, string>>,
    right: Readonly<Record<string, string>>,
): boolean {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) {
        return false;
    }
    return keys.every(
        (key) => Object.hasOwn(right, key) && left[key] === right[key],
    );
}

function freezeStyleDef(def: StyleDef): StyleDef {
    return Object.freeze({
        basedOn: def.basedOn,
        fields: Object.freeze({ ...def.fields }),
    });
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
