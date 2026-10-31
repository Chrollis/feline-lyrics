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
    withStyle,
} from '../../src/main/lyrics/stylebook.js';
import { NO_ANIMATIONS, textToLyrics } from '../../src/main/lyrics/lyrics.js';

function def(basedOn = null, fields = {}) {
    return { basedOn, fields };
}

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
        const after = withStyle(
            before,
            'chorus',
            def(null, { color: '#ff0000' }),
        );
        assert.equal(styleIds(before).length, 0, 'the input is untouched');
        assert.deepEqual(styleIds(after), ['chorus']);
        assert.deepEqual(styleDefAt(after, 'chorus'), {
            basedOn: null,
            fields: { color: '#ff0000' },
        });
        assert.equal(isValidStyleBook(after), true);
    });

    it('returns the same book when nothing changes', () => {
        const book = withStyle(
            emptyStyleBook(),
            'chorus',
            def(null, { a: '1' }),
        );
        assert.equal(withStyle(book, 'chorus', def(null, { a: '1' })), book);
        assert.notEqual(withStyle(book, 'chorus', def(null, { a: '2' })), book);
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
            () => withStyle(emptyStyleBook(), 'child', def('missing')),
            (error) => {
                return (
                    error.code === 'invalid-style-def' &&
                    error.message.includes('missing')
                );
            },
        );
    });

    it('refuses to inherit from itself', () => {
        assert.throws(
            () => withStyle(emptyStyleBook(), 'loop', def('loop')),
            (error) => error.code === 'invalid-style-def',
        );
    });

    it('refuses a new parent edge that closes a cycle', () => {
        const a = withStyle(emptyStyleBook(), 'a', def(null));
        const b = withStyle(a, 'b', def('a'));

        assert.throws(
            () => withStyle(b, 'a', def('b')),
            (error) => error.code === 'invalid-style-book',
        );
    });

    it('refuses a field name or value that is not a plain string', () => {
        assert.throws(
            () =>
                withStyle(emptyStyleBook(), 'x', def(null, { 'bad key': 'v' })),
            (error) => error.code === 'invalid-style-def',
        );
        assert.throws(
            () =>
                withStyle(
                    emptyStyleBook(),
                    'x',
                    def(null, { color: /** @type {any} */ (3) }),
                ),
            (error) => error.code === 'invalid-style-def',
        );
    });

    it('keeps an id spelled __proto__ as data', () => {
        const book = withStyle(
            emptyStyleBook(),
            '__proto__',
            def(null, { color: 'red' }),
        );
        assert.deepEqual(styleIds(book), ['__proto__']);
        assert.deepEqual(styleDefAt(book, '__proto__')?.fields, {
            color: 'red',
        });
        assert.equal(styleDefAt(book, 'toString'), null);
    });
});

describe('resolving an inheritance chain', () => {
    const root = withStyle(
        emptyStyleBook(),
        'root',
        def(null, { color: 'red', weight: '400' }),
    );
    const child = withStyle(root, 'child', def('root', { weight: '700' }));
    const grandchild = withStyle(child, 'grandchild', def('child', {}));

    it('merges parents first and the child last', () => {
        assert.deepEqual(resolveStyle(child, 'child'), {
            color: 'red',
            weight: '700',
        });
        assert.deepEqual(resolveStyle(grandchild, 'grandchild'), {
            color: 'red',
            weight: '700',
        });
    });

    it('treats an empty value as "inherit", not as "clear"', () => {
        const quiet = withStyle(root, 'quiet', def('root', { color: '' }));
        assert.deepEqual(resolveStyle(quiet, 'quiet'), {
            color: 'red',
            weight: '400',
        });
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
    const root = withStyle(emptyStyleBook(), 'root', def(null, { a: '1' }));
    const book = withStyle(root, 'child', def('root', { b: '2' }));

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
        assert.deepEqual(resolveStyle(book, 's32'), {});
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
