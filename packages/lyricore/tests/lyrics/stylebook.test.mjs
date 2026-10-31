import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    STYLE_ID_PATTERN,
    assertStyleBook,
    emptyStyleBook,
    isValidStyleBook,
    removeStyle,
    resolveStyle,
    styleBookProblem,
    styleDefAt,
    styleDepth,
    styleIds,
    styleInheritors,
    styleSpace,
    withStyle,
} from '../../src/main/lyrics/stylebook.js';
import { defaultContent } from '../../src/main/lyrics/stylecontent.js';
import { NO_ANIMATIONS, textToLyrics } from '../../src/main/lyrics/lyrics.js';

function def(basedOn = null, content = {}) {
    return { basedOn, content };
}

function fill(color) {
    return { normal: { kind: 'solid', color } };
}

const RED = fill('#ff0000');

describe('an empty style book', () => {
    it('is one frozen value, so identity is a valid comparison', () => {
        assert.equal(emptyStyleBook(), emptyStyleBook());
        assert.deepEqual(emptyStyleBook(), { defs: {} });
        assert.equal(isValidStyleBook(emptyStyleBook()), true);
    });

    it('has no ids and no definitions', () => {
        assert.deepEqual(styleIds(emptyStyleBook()), []);
        assert.equal(styleDefAt(emptyStyleBook(), 'chorus'), null);
        assert.equal(styleDepth(emptyStyleBook(), 'chorus'), -1);
        assert.equal(resolveStyle(emptyStyleBook(), 'chorus'), null);
    });

    it('rejects an object that is not a book', () => {
        assert.equal(isValidStyleBook(null), false);
        assert.equal(isValidStyleBook({}), false);
        assert.notEqual(styleBookProblem({ defs: [] }), null);
    });
});

describe('writing a definition', () => {
    it('adds one and leaves the old book alone', () => {
        const before = emptyStyleBook();
        const after = withStyle(before, 'chorus', def(null, { fill: RED }));
        assert.equal(styleIds(before).length, 0, 'the input is untouched');
        assert.deepEqual(styleIds(after), ['chorus']);
        assert.deepEqual(styleDefAt(after, 'chorus'), {
            basedOn: null,
            content: { fill: RED },
        });
        assert.equal(isValidStyleBook(after), true);
    });

    it('returns the same book when nothing changes', () => {
        const book = withStyle(
            emptyStyleBook(),
            'chorus',
            def(null, { sizePx: 48 }),
        );
        assert.equal(
            withStyle(book, 'chorus', def(null, { sizePx: 48 })),
            book,
        );
        assert.notEqual(
            withStyle(book, 'chorus', def(null, { sizePx: 49 })),
            book,
        );
    });

    it('refuses a malformed id', () => {
        for (const id of ['', 'has space', 'x'.repeat(33), 'a/b']) {
            assert.throws(
                () => withStyle(emptyStyleBook(), id, def()),
                (error) => error.code === 'invalid-style-def',
                `id ${JSON.stringify(id)} should be refused`,
            );
        }
        assert.equal(STYLE_ID_PATTERN.test('chorus-2_A'), true);
    });

    it('refuses a parent that is not in the book', () => {
        assert.throws(
            () => withStyle(emptyStyleBook(), 'child', def('gone')),
            (error) => error.code === 'invalid-style-def',
        );
    });

    it('refuses a definition that is its own parent', () => {
        assert.throws(
            () => withStyle(emptyStyleBook(), 'a', def('a')),
            (error) => error.code === 'invalid-style-def',
        );
    });

    it('refuses content the space does not have', () => {
        assert.throws(
            () =>
                withStyle(
                    emptyStyleBook(),
                    'x',
                    def(null, { color: '#ff0000' }),
                ),
            (error) => error.code === 'invalid-style-def',
        );
        assert.throws(
            () => withStyle(emptyStyleBook(), 'x', def(null, { weight: 3 })),
            (error) => error.code === 'invalid-style-def',
        );
    });

    it('keeps an id spelled __proto__ as data', () => {
        const book = withStyle(
            emptyStyleBook(),
            '__proto__',
            def(null, { sizePx: 64 }),
        );
        assert.deepEqual(styleIds(book), ['__proto__']);
        assert.deepEqual(styleDefAt(book, '__proto__')?.content, {
            sizePx: 64,
        });
        assert.equal(styleDefAt(book, 'toString'), null);
    });
});

describe('resolving an inheritance chain', () => {
    const root = withStyle(
        emptyStyleBook(),
        'root',
        def(null, { fill: RED, weight: 400 }),
    );
    const child = withStyle(root, 'child', def('root', { weight: 700 }));
    const grandchild = withStyle(child, 'grandchild', def('child', {}));

    it('merges parents first and the child last', () => {
        assert.deepEqual(resolveStyle(child, 'child'), {
            ...defaultContent('character'),
            fill: RED,
            weight: 700,
        });
        assert.deepEqual(resolveStyle(grandchild, 'grandchild'), {
            ...defaultContent('character'),
            fill: RED,
            weight: 700,
        });
    });

    it('treats an absent field as "inherit", not as "clear"', () => {
        const quiet = withStyle(root, 'quiet', def('root', {}));
        assert.deepEqual(resolveStyle(quiet, 'quiet'), {
            ...defaultContent('character'),
            fill: RED,
            weight: 400,
        });
    });

    it('replaces a whole object instead of merging into it', () => {
        const child2 = withStyle(
            root,
            'child2',
            def('root', { fill: fill('#00ff00') }),
        );
        assert.deepEqual(resolveStyle(child2, 'child2').fill, fill('#00ff00'));
    });

    it('counts the links to the root', () => {
        assert.equal(styleDepth(root, 'root'), 0);
        assert.equal(styleDepth(child, 'child'), 1);
        assert.equal(styleDepth(grandchild, 'grandchild'), 2);
    });

    it('lists the styles that inherit from one', () => {
        assert.deepEqual(styleInheritors(grandchild, 'root'), ['child']);
        assert.deepEqual(styleInheritors(grandchild, 'grandchild'), []);
    });
});

describe('removing a definition', () => {
    const root = withStyle(emptyStyleBook(), 'root', def(null, { sizePx: 48 }));
    const book = withStyle(root, 'child', def('root', { sizePx: 50 }));

    it('drops a leaf', () => {
        const after = removeStyle(book, 'child');
        assert.deepEqual(styleIds(after), ['root']);
    });

    it('is a no-op for an unknown id', () => {
        assert.equal(removeStyle(book, 'nope'), book);
    });

    it('refuses while something inherits from it, and names it', () => {
        assert.throws(
            () => removeStyle(book, 'root'),
            (error) => {
                return (
                    error.code === 'invalid-style-book' &&
                    error.message.includes('child')
                );
            },
        );
    });
});

describe('a hand-built book that contradicts itself', () => {
    it('rejects a dangling parent', () => {
        const broken = {
            defs: { child: def('gone', {}) },
        };
        assert.notEqual(styleBookProblem(broken), null);
        assert.equal(isValidStyleBook(broken), false);
        assert.throws(
            () => assertStyleBook(broken),
            (error) => error.code === 'invalid-style-book',
        );
    });

    it('rejects a cycle instead of resolving forever', () => {
        const broken = {
            defs: {
                a: def('b', {}),
                b: def('a', {}),
            },
        };
        assert.notEqual(styleBookProblem(broken), null);
        assert.throws(
            () => resolveStyle(broken, 'a'),
            (error) => error.code === 'invalid-style-book',
        );
        assert.equal(styleDepth(broken, 'a'), -1);
    });

    it('accepts a book that only wires real ids', () => {
        const book = withStyle(
            withStyle(emptyStyleBook(), 'a', def(null, {})),
            'b',
            def('a', {}),
        );
        assert.equal(styleBookProblem(book), null);
        assert.equal(assertStyleBook(book), book);
    });

    it('stops one link past the depth bound', () => {
        // The chain holds the id plus one entry per link, so depth 32 is 33
        // entries: the bound counts links, not entries.
        let book = withStyle(emptyStyleBook(), 's0', def(null, {}));
        for (let index = 1; index <= 32; index += 1) {
            book = withStyle(book, `s${index}`, def(`s${index - 1}`, {}));
        }
        assert.equal(styleDepth(book, 's32'), 32);
        assert.deepEqual(
            resolveStyle(book, 's32'),
            defaultContent('character'),
        );
        // A 33rd link is refused when it is added: the book that holds it
        // cannot be written at all, so it cannot reach a reader either.
        assert.throws(
            () => withStyle(book, 's33', def('s32', {})),
            (error) => error.code === 'invalid-style-book',
        );
        const deeper = { defs: { ...book.defs, s33: def('s32', {}) } };
        assert.throws(
            () => resolveStyle(deeper, 's33'),
            (error) => error.code === 'invalid-style-book',
        );
    });
});

describe('the document carries the two layers', () => {
    it('starts a fresh document with the empty book and no animations', () => {
        const lyrics = textToLyrics('a\nb\n');
        assert.equal(lyrics.styleBook, emptyStyleBook());
        assert.equal(lyrics.animations, NO_ANIMATIONS);
        assert.equal(Object.isFrozen(NO_ANIMATIONS), true);
    });
});

describe('the space of a definition', () => {
    it('is character when the definition does not say', () => {
        const book = withStyle(
            emptyStyleBook(),
            'chorus',
            def(null, { sizePx: 48 }),
        );
        assert.equal(styleSpace(styleDefAt(book, 'chorus')), 'character');
        // Absent is the storage form: a character style does not carry the key.
        assert.equal(Object.hasOwn(styleDefAt(book, 'chorus'), 'space'), false);
    });

    it('is kept as written for the other two spaces', () => {
        const book = withStyle(emptyStyleBook(), 'ruby-a', {
            basedOn: null,
            space: 'run',
            content: { position: 'below' },
        });
        assert.equal(styleSpace(styleDefAt(book, 'ruby-a')), 'run');
        assert.equal(isValidStyleBook(book), true);
    });

    it('refuses a space it does not know', () => {
        assert.throws(
            () =>
                withStyle(emptyStyleBook(), 'x', {
                    basedOn: null,
                    space: 'glyph',
                    content: {},
                }),
            (error) =>
                error.code === 'invalid-style-def' &&
                error.message.includes('space'),
        );
    });

    it('refuses a parent in another space', () => {
        const book = withStyle(emptyStyleBook(), 'chorus', def(null, {}));
        assert.throws(
            () =>
                withStyle(book, 'chorus-run', {
                    basedOn: 'chorus',
                    space: 'run',
                    content: {},
                }),
            (error) =>
                error.code === 'invalid-style-def' &&
                error.message.includes('inherits from the character style'),
        );
    });

    it('is part of the identity fast path', () => {
        const book = withStyle(
            emptyStyleBook(),
            'chorus',
            def(null, { sizePx: 48 }),
        );
        assert.equal(
            withStyle(book, 'chorus', def(null, { sizePx: 48 })),
            book,
        );
        const moved = withStyle(book, 'chorus', {
            basedOn: null,
            space: 'run',
            content: { align: 'left' },
        });
        assert.notEqual(moved, book);
        assert.equal(styleSpace(styleDefAt(moved, 'chorus')), 'run');
    });

    it('reports a space a hand-built book holds', () => {
        const book = {
            defs: { x: { basedOn: null, space: 'glyph', content: {} } },
        };
        assert.match(styleBookProblem(book), /space/);
    });
});
