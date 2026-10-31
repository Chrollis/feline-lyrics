import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { importTagText } from '../../src/main/io/tagtext.js';
import { lyricsToExportJson } from '../../src/main/lyrics/file.js';
import { withOverlay } from '../../src/main/lyrics/line.js';
import { NO_ANIMATIONS, textToLyrics } from '../../src/main/lyrics/lyrics.js';
import { emptyStyleBook, withStyle } from '../../src/main/lyrics/stylebook.js';
import {
    lyricsToProject,
    lyricsToProjectJson,
    projectToLyrics,
    readProjectJson,
} from '../../src/main/project/index.js';

const PROJECT_FORMAT = 'felyrics/lyrics-project';

function style(offset, length, styleId) {
    return { offset, length, styleId };
}

function marker(id, offset, kind = 'soft-break') {
    return { id, kind, anchor: { offset, length: 0 }, content: null };
}

function book() {
    const base = withStyle(emptyStyleBook(), 'chorus', {
        basedOn: null,
        fields: { color: '0xffcc00' },
    });
    return withStyle(base, 'chorus-hot', {
        basedOn: 'chorus',
        fields: { color: '0xff5500' },
    });
}

/** One document that uses every section: table, overlay, animations. */
function fixture() {
    const lyrics = textToLyrics('a b c\nde\n');
    const painted = lyrics.lines.map((line) => {
        if (line.baseStream.cells.length !== 6) {
            return line;
        }
        return withOverlay(line, {
            styles: [style(0, 1, 'chorus'), style(2, 1, 'chorus-hot')],
            inserted: [marker('m1', 1)],
        });
    });
    return {
        meta: lyrics.meta,
        lines: painted,
        styleBook: book(),
        animations: [{ id: 'a1', script: 'fade' }],
    };
}

function parsed() {
    return JSON.parse(lyricsToProjectJson(fixture()));
}

function rejects(mutate, expected) {
    const value = parsed();
    mutate(value);
    assert.throws(
        () => projectToLyrics(value),
        (error) =>
            error.code === 'invalid-project-file' &&
            (typeof expected === 'string'
                ? error.message.includes(expected)
                : expected.test(error.message)),
    );
}

describe('the project document', () => {
    it('is the shape the plan describes', () => {
        const value = parsed();
        assert.deepEqual(Object.keys(value), [
            'format',
            'version',
            'lyrics',
            'styleBook',
            'overlay',
            'animations',
        ]);
        assert.equal(value.format, PROJECT_FORMAT);
        assert.equal(value.version, 1);
        assert.equal(value.lyrics.format, 'felyrics/lyrics');
        assert.equal(value.overlay.length, value.lyrics.lines.length);
    });

    it('keeps the embedded block equal to the frozen export', () => {
        const lyrics = fixture();
        const value = parsed();
        assert.deepEqual(value.lyrics, JSON.parse(lyricsToExportJson(lyrics)));
        // The block may not grow an overlay key: the frozen reader would drop
        // it on the next save. Object.hasOwn on a string never finds one, so
        // the check is on the text the block serialises to.
        assert.equal(JSON.stringify(value.lyrics).includes('"overlay"'), false);
    });

    it('rejects a field name only the prototype could hold', () => {
        rejects((value) => {
            value.styleBook.defs.chorus.fields = { ['__proto__']: 'x' };
        }, 'not a property name');
    });

    it('round-trips a write back into the same text', () => {
        const text = lyricsToProjectJson(fixture());
        const read = readProjectJson(text);
        assert.equal(lyricsToProjectJson(read.lyrics), text);
        assert.deepEqual(read.issues, []);
    });

    it('reads back what it wrote, section by section', () => {
        const read = readProjectJson(lyricsToProjectJson(fixture()));
        const line = read.lyrics.lines[0];
        assert.deepEqual(line.overlay.styles, [
            style(0, 1, 'chorus'),
            style(2, 1, 'chorus-hot'),
        ]);
        assert.deepEqual(line.overlay.inserted, [marker('m1', 1)]);
        assert.deepEqual(read.lyrics.styleBook.defs['chorus'], {
            basedOn: null,
            fields: { color: '0xffcc00' },
        });
        assert.deepEqual(read.lyrics.animations, [
            { id: 'a1', script: 'fade' },
        ]);
    });

    it('round-trips a document with no lines', () => {
        const empty = textToLyrics('');
        const text = lyricsToProjectJson(empty);
        const value = JSON.parse(text);
        assert.equal(Object.hasOwn(value, 'overlay'), false);
        assert.deepEqual(readProjectJson(text).lyrics.lines, []);
    });

    it('writes an unstyled line as an empty entry', () => {
        const value = parsed();
        assert.deepEqual(value.overlay[1], {});
    });

    it('omits the sections that are empty', () => {
        const oneLine = JSON.parse(lyricsToProjectJson(textToLyrics('a\n')));
        assert.deepEqual(Object.keys(oneLine), [
            'format',
            'version',
            'lyrics',
            'overlay',
        ]);
        assert.deepEqual(oneLine.overlay, [{}]);

        const noLines = JSON.parse(lyricsToProjectJson(textToLyrics('')));
        assert.deepEqual(Object.keys(noLines), ['format', 'version', 'lyrics']);
    });

    it('rejects a foreign format', () => {
        rejects((value) => {
            value.format = 'felyrics/other';
        }, /format/);
    });

    it('rejects a version that is not a positive integer', () => {
        for (const version of [undefined, '1', 1.5, 0, -1]) {
            rejects((value) => {
                value.version = version;
            }, /version/);
        }
    });

    it('rejects a file written by a newer version', () => {
        rejects((value) => {
            value.version = 2;
        }, /newer version/);
    });

    it('rejects an unknown key at every depth', () => {
        const rows = [
            ['mystery', (value) => (value.mystery = 1)],
            [
                'lyrics.lines[0].overlay',
                (value) => (value.lyrics.lines[0].overlay = { styles: [] }),
            ],
            [
                'lyrics.lines[0].mystery',
                (value) => (value.lyrics.lines[0].mystery = 1),
            ],
            ['overlay[0].mystery', (value) => (value.overlay[0].mystery = 1)],
            [
                'overlay[0].inserted[0].mystery',
                (value) => (value.overlay[0].inserted[0].mystery = 1),
            ],
            [
                'styleBook.defs.chorus.mystery',
                (value) => (value.styleBook.defs.chorus.mystery = 1),
            ],
        ];
        for (const [path, mutate] of rows) {
            rejects(mutate, path);
        }
    });

    it('rejects a lyrics block that is missing or malformed', () => {
        rejects((value) => {
            delete value.lyrics;
        }, 'lyrics');
        rejects((value) => {
            value.lyrics = [];
        }, 'lyrics');
        // The sweep passes this one through; the frozen reader rejects it, and
        // its path is merged into the block's rather than prefixed as a whole.
        rejects((value) => {
            value.lyrics.lines[0].spans = 'nope';
        }, 'lyrics.lines[0].spans');
    });

    it('rejects an overlay that does not line up with the lines', () => {
        rejects((value) => {
            value.overlay = {};
        }, /overlay/);
        rejects((value) => {
            value.overlay.push({});
        }, /entries/);
        rejects((value) => {
            value.overlay[0] = null;
        }, /overlay\[0\]/);
    });

    it('rejects a style run that leaves the body', () => {
        for (const run of [
            style(5, 1, 'chorus'),
            style(0, 0, 'chorus'),
            style(-1, 1, 'chorus'),
            style(0, 1, ''),
        ]) {
            rejects((value) => {
                value.overlay[0].styles = [run];
            }, /overlay\[0\]/);
        }
    });

    it('rejects overlapping and unsorted style runs', () => {
        rejects((value) => {
            value.overlay[0].styles = [
                style(2, 2, 'chorus'),
                style(1, 1, 'chorus'),
            ];
        }, /overlay\[0\]/);
        rejects((value) => {
            value.overlay[0].styles = [
                style(0, 3, 'chorus'),
                style(2, 1, 'chorus'),
            ];
        }, /overlay\[0\]/);
    });

    it('reports an orphan style id and keeps the run', () => {
        const value = parsed();
        value.overlay[0].styles[0].styleId = 'nobody';
        const read = projectToLyrics(value);
        assert.deepEqual(read.issues, [
            { code: 'style-orphan', styleId: 'nobody' },
        ]);
        assert.equal(read.lyrics.lines[0].overlay.styles[0].styleId, 'nobody');
    });

    it('reports an orphan style on an inserted text block too', () => {
        // The text of an inserted block paints itself with a style id, so it
        // has to resolve exactly like a run does; nothing else checks it.
        const value = parsed();
        value.overlay[0].inserted = [
            {
                id: 't1',
                kind: 'text',
                anchor: [1, 0],
                content: { type: 'text', lines: ['x'], styleId: 'nope' },
            },
        ];
        const read = projectToLyrics(value);
        assert.deepEqual(read.issues, [
            { code: 'style-orphan', styleId: 'nope' },
        ]);
        assert.equal(
            read.lyrics.lines[0].overlay.inserted[0].content.styleId,
            'nope',
        );

        const valid = parsed();
        valid.overlay[0].inserted = [
            {
                id: 't1',
                kind: 'text',
                anchor: [1, 0],
                content: { type: 'text', lines: ['x'], styleId: 'chorus' },
            },
        ];
        assert.deepEqual(projectToLyrics(valid).issues, []);
    });

    it('reads an empty basedOn as no parent and rejects a dangling one', () => {
        const value = parsed();
        value.styleBook.defs['chorus-hot'].basedOn = '';
        assert.equal(
            projectToLyrics(value).lyrics.styleBook.defs['chorus-hot'].basedOn,
            null,
        );
        value.styleBook.defs['chorus-hot'].basedOn = 'missing';
        assert.throws(
            () => projectToLyrics(value),
            (error) => error.code === 'invalid-project-file',
        );
    });

    it('rejects a style def cycle and a bad field map', () => {
        rejects((value) => {
            value.styleBook.defs.chorus.basedOn = 'chorus-hot';
        }, /styleBook/);
        rejects((value) => {
            value.styleBook.defs.chorus.fields = { color: 7 };
        }, /styleBook\.defs\.chorus\.fields/);
    });

    it('rejects an inserted object that breaks the id grammar or duplicates', () => {
        rejects((value) => {
            value.overlay[0].inserted[0].id = 'not valid';
        }, /overlay\[0\]/);
        rejects((value) => {
            value.overlay[1].inserted = [{ ...value.overlay[0].inserted[0] }];
        }, /appears twice/);
    });

    it('rejects a kind and a content that disagree', () => {
        rejects((value) => {
            value.overlay[0].inserted[0].content = {
                type: 'text',
                lines: ['x'],
            };
        }, /overlay\[0\]/);
        rejects((value) => {
            value.overlay[0].inserted[0].kind = 'text';
        }, /overlay\[0\]/);
        rejects((value) => {
            value.overlay[0].inserted[0].kind = '';
        }, /overlay\[0\]/);
        rejects((value) => {
            value.overlay[0].inserted[0].content = { type: 'video' };
        }, /type/);
    });

    it('rejects malformed content and accepts the edges of the grammar', () => {
        rejects((value) => {
            value.overlay[0].inserted = [
                {
                    id: 't1',
                    kind: 'text',
                    anchor: [1, 1],
                    content: { type: 'text', lines: [] },
                },
            ];
        }, /lines/);
        rejects((value) => {
            value.overlay[0].inserted = [
                {
                    id: 'i1',
                    kind: 'image',
                    anchor: [1, 1],
                    content: { type: 'image', src: 'a.png', scale: 0 },
                },
            ];
        }, /scale/);
        const value = parsed();
        value.overlay[0].inserted = [
            {
                id: 'i1',
                kind: 'image',
                anchor: [1, 1],
                content: { type: 'image', src: 'a.png', scale: null },
                time: [-1000, 500],
            },
        ];
        const read = projectToLyrics(value);
        assert.deepEqual(read.lyrics.lines[0].overlay.inserted[0].time, {
            start: -1000,
            duration: 500,
        });
    });

    it('rejects an anchor that leaves the body but accepts an edge marker', () => {
        rejects((value) => {
            value.overlay[0].inserted[0].anchor = [6, 0];
        }, /overlay\[0\]/);
        rejects((value) => {
            value.overlay[0].inserted[0].anchor = [4, 2];
        }, /overlay\[0\]/);
        const value = parsed();
        value.overlay[0].inserted[0].anchor = [5, 0];
        assert.equal(
            projectToLyrics(value).lyrics.lines[0].overlay.inserted[0].anchor
                .offset,
            5,
        );
    });

    it('rejects a null content with a painted anchor', () => {
        rejects((value) => {
            value.overlay[0].inserted[0].anchor = [1, 2];
        }, /overlay\[0\]/);
    });

    it('rejects an animations value that is not an array', () => {
        rejects((value) => {
            value.animations = {};
        }, /animations/);
    });

    it('carries an animation it does not understand', () => {
        const value = parsed();
        value.animations = [42, { anything: ['goes'] }];
        const read = projectToLyrics(value);
        assert.deepEqual(read.lyrics.animations, [42, { anything: ['goes'] }]);
        assert.equal(
            JSON.parse(lyricsToProjectJson(read.lyrics)).animations[1]
                .anything[0],
            'goes',
        );
    });

    it('rejects text that is not JSON', () => {
        assert.throws(
            () => readProjectJson('{'),
            (error) =>
                error.code === 'invalid-project-file' &&
                /not JSON/.test(error.message),
        );
    });

    it('writes the same bytes for two equal values', () => {
        const first = textToLyrics('a\n');
        const second = textToLyrics('a\n');
        assert.equal(
            lyricsToProjectJson({ ...first, animations: NO_ANIMATIONS }),
            lyricsToProjectJson(second),
        );
        // The text form is exactly the file form at four spaces, so a reader
        // that reserialises cannot change a byte by accident.
        const text = lyricsToProjectJson(first);
        assert.equal(`${JSON.stringify(JSON.parse(text), null, 4)}\n`, text);
    });
});

function timedText() {
    const imported = importTagText('[00:00:01.00]ab\n', {});
    return lyricsToProjectJson(imported.lyrics ?? imported);
}

function rejectsValue(value, expected) {
    assert.throws(
        () => projectToLyrics(value),
        (error) =>
            error.code === 'invalid-project-file' &&
            (typeof expected === 'string'
                ? error.message.includes(expected)
                : expected.test(error.message)),
    );
}

describe('the project document, edge by edge', () => {
    it('rejects an unknown key in the metadata', () => {
        // `metaFromFile` rebuilds from known fields, so this key would vanish.
        rejects((value) => {
            value.lyrics.meta.mystery = 1;
        }, 'lyrics.meta');
    });

    it('rejects an unknown key on a run and on a piece', () => {
        const rows = [
            [
                'groups.default[0]',
                (value) => {
                    value.lyrics.lines[0].groups.default[0].mystery = 1;
                },
            ],
            [
                'pieces[0]',
                (value) => {
                    value.lyrics.lines[0].groups.default[0].pieces[0].mystery = 1;
                },
            ],
            [
                '.check',
                (value) => {
                    // `checkFromFile` rebuilds the check from time and type, so
                    // a third key inside it would be dropped without a word.
                    value.lyrics.lines[0].groups.default[0].pieces[0].check = {
                        time: 1000,
                        type: 'KeyDown',
                        mystery: 1,
                    };
                },
            ],
        ];
        for (const [expected, mutate] of rows) {
            const value = JSON.parse(timedText());
            mutate(value);
            rejectsValue(value, expected);
        }
    });

    it('rejects an unknown key on the block and on the style book', () => {
        rejects((value) => {
            value.lyrics.mystery = 1;
        }, 'lyrics.mystery');
        rejects((value) => {
            value.styleBook.mystery = 1;
        }, 'styleBook');
    });

    it('rejects an unknown key inside both content shapes', () => {
        rejects((value) => {
            value.overlay[0].inserted = [
                {
                    id: 't1',
                    kind: 'text',
                    anchor: [1, 1],
                    content: { type: 'text', lines: ['x'], mystery: 1 },
                },
            ];
        }, '.content');
        rejects((value) => {
            value.overlay[0].inserted = [
                {
                    id: 'i1',
                    kind: 'image',
                    anchor: [1, 1],
                    content: { type: 'image', src: 'a.png', mystery: 1 },
                },
            ];
        }, '.content');
    });

    it('accepts what the timing fixture writes', () => {
        const read = projectToLyrics(JSON.parse(timedText()));
        assert.equal(read.lyrics.lines[0].groups.default.length, 1);
        assert.deepEqual(read.issues, []);
    });

    it('merges adjacent runs that name the same style on write', () => {
        const base = textToLyrics('abc\n');
        const line = withOverlay(base.lines[0], {
            styles: [style(0, 1, 'a'), style(1, 1, 'a')],
            inserted: [],
        });
        const value = JSON.parse(
            lyricsToProjectJson({ ...base, lines: [line] }),
        );
        assert.deepEqual(value.overlay[0].styles, [style(0, 2, 'a')]);
    });

    it('writes a time span as a start-duration pair', () => {
        const base = textToLyrics('abc\n');
        const line = withOverlay(base.lines[0], {
            styles: [],
            inserted: [
                {
                    id: 'i1',
                    kind: 'image',
                    anchor: { offset: 0, length: 1 },
                    content: { type: 'image', src: 'a.png' },
                    time: { start: 10, duration: 20 },
                },
            ],
        });
        const value = JSON.parse(
            lyricsToProjectJson({ ...base, lines: [line] }),
        );
        assert.deepEqual(value.overlay[0].inserted[0].time, [10, 20]);
    });

    it('writes the definitions in id order', () => {
        const base = textToLyrics('a\n');
        const book2 = withStyle(
            withStyle(emptyStyleBook(), 'zzz', { basedOn: null, fields: {} }),
            'aaa',
            { basedOn: null, fields: {} },
        );
        const value = JSON.parse(
            lyricsToProjectJson({ ...base, styleBook: book2 }),
        );
        assert.deepEqual(Object.keys(value.styleBook.defs), ['aaa', 'zzz']);
    });

    it('refuses to write a book whose parent does not resolve', () => {
        // Writing first and validating on the next read would put a document on
        // disk that this package can never open again.
        const base = textToLyrics('a\n');
        const broken = {
            ...base,
            styleBook: {
                defs: { a: { basedOn: 'missing', fields: { color: 'x' } } },
            },
        };
        const invalid = (error) => error.code === 'invalid-style-book';
        assert.throws(() => lyricsToProject(broken), invalid);
        assert.throws(() => lyricsToProjectJson(broken), invalid);
    });

    it('rejects a defs value that is not an object', () => {
        // An empty book would turn every painted line into a style-orphan storm.
        rejects((value) => {
            value.styleBook.defs = [];
        }, 'styleBook.defs');
    });

    it('reads an absent overlay as no paint', () => {
        // REV 6: an absent overlay means nothing is painted, not a bad file.
        const value = parsed();
        delete value.overlay;
        const read = projectToLyrics(value);
        assert.deepEqual(read.lyrics.lines[0].overlay.styles, []);
        assert.deepEqual(read.lyrics.lines[1].overlay.styles, []);
    });

    it('reads a literal null content as no content', () => {
        const value = parsed();
        value.overlay[0].inserted[0].content = null;
        const read = projectToLyrics(value);
        assert.equal(read.lyrics.lines[0].overlay.inserted[0].content, null);
    });

    it('names the object index when an id repeats', () => {
        const value = parsed();
        value.overlay[1].inserted = [{ ...value.overlay[0].inserted[0] }];
        rejectsValue(value, 'overlay[1].inserted[0]');
    });

    it('rejects a negative time and keeps a zero duration', () => {
        // time.ts:66-79 - start is any int32, duration is >= 0.
        rejects((value) => {
            value.overlay[0].inserted[0].time = [0, -1];
        }, '.time');
        const value = parsed();
        value.overlay[0].inserted[0].time = [0, 0];
        assert.deepEqual(
            projectToLyrics(value).lyrics.lines[0].overlay.inserted[0].time,
            { start: 0, duration: 0 },
        );
    });
});
