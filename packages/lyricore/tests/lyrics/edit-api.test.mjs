import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { textToStream } from '../../src/main/lyrics/char.js';
import {
    withGroup,
    withPiece,
    withPieceText,
    withRun,
} from '../../src/main/lyrics/line.js';
import { withMeta } from '../../src/main/lyrics/lyrics.js';
import { emptyMeta } from '../../src/main/lyrics/meta.js';
import { terminalRun } from '../../src/main/lyrics/seg-run.js';
import { lineSpan, pieceStart, runStart } from '../../src/main/lyrics/views.js';

function piece(text, check = null) {
    return { check, text: textToStream(text) };
}

function run(offset, length, pieces = []) {
    return { offset, length, pieces };
}

function line(text, groups = {}) {
    return { baseStream: textToStream(text), groups };
}

function lyrics(line0) {
    return { meta: emptyMeta(), lines: [line0] };
}

/** "あいう\n" with a ruby run over あい, one over う, and the terminal run. */
function three() {
    return line('あいう\n', {
        ruby: [
            run(0, 2, [piece('とう')]),
            run(2, 1, [piece('う')]),
            run(3, 1, [piece('')]),
        ],
    });
}

function own(error, code) {
    return error instanceof Error && error.code === code;
}

describe('editing annotation pieces', () => {
    it('replaces the reading of one piece and keeps its check', () => {
        const marked = withPiece(
            three(),
            { group: 'ruby', runIndex: 0, pieceIndex: 0 },
            {
                check: { time: 1_000, type: 'KeyDown' },
                text: textToStream('東京'),
            },
        );
        const edited = withPieceText(
            marked,
            { group: 'ruby', runIndex: 0, pieceIndex: 0 },
            'きょう',
        );
        assert.equal(
            edited.groups.ruby[0].pieces[0].text.cells
                .map((cell) => cell.text)
                .join(''),
            'きょう',
        );
        assert.deepEqual(edited.groups.ruby[0].pieces[0].check, {
            time: 1_000,
            type: 'KeyDown',
        });
    });

    it('leaves the line alone when the reading is unchanged', () => {
        const before = three();
        const after = withPieceText(
            before,
            { group: 'ruby', runIndex: 0, pieceIndex: 0 },
            'とう',
        );
        assert.equal(after, before);
    });

    it('refuses a reading that carries a line break', () => {
        assert.throws(
            () =>
                withPieceText(
                    three(),
                    { group: 'ruby', runIndex: 0, pieceIndex: 0 },
                    'と\nう',
                ),
            (error) => own(error, 'invalid-seg-piece'),
        );
    });

    it('appends a piece when the index is the piece count', () => {
        const after = withPiece(
            three(),
            { group: 'ruby', runIndex: 1, pieceIndex: 1 },
            piece('ん'),
        );
        assert.equal(after.groups.ruby[1].pieces.length, 2);
        assert.equal(after.groups.ruby[1].pieces[1].text.cells[0].text, 'ん');
    });

    it('removes a piece and rejects emptying the terminal run', () => {
        const after = withPiece(
            three(),
            { group: 'ruby', runIndex: 1, pieceIndex: 0 },
            null,
        );
        assert.equal(after.groups.ruby[1].pieces.length, 0);
        assert.throws(
            () =>
                withPiece(
                    three(),
                    { group: 'ruby', runIndex: 2, pieceIndex: 0 },
                    null,
                ),
            (error) => own(error, 'invalid-lyrics-line'),
        );
    });
});

describe('editing annotation runs', () => {
    it('replaces a run, keeps the others, and follows the terminal rule', () => {
        const after = withRun(
            three(),
            'ruby',
            1,
            run(2, 1, [piece('う'), piece('')]),
        );
        assert.equal(after.groups.ruby.length, 3);
        assert.equal(after.groups.ruby[1].pieces.length, 2);
    });

    it('refuses a run that overlaps its neighbour', () => {
        assert.throws(
            () => withRun(three(), 'ruby', 1, run(1, 2, [piece('う')])),
            (error) => own(error, 'invalid-lyrics-line'),
        );
    });

    it('refuses a run added past the terminal run', () => {
        assert.throws(
            () => withRun(three(), 'ruby', 3, run(3, 1, [piece('')])),
            (error) => own(error, 'invalid-lyrics-line'),
        );
    });

    it('removes a run and keeps the line valid', () => {
        const after = withRun(three(), 'ruby', 1, null);
        assert.equal(after.groups.ruby.length, 2);
    });
});

describe('editing annotation groups', () => {
    it('adds a group that holds only its terminal run', () => {
        const after = withGroup(three(), 'romaji', [terminalRun(3)]);
        assert.deepEqual(Object.keys(after.groups).sort(), ['romaji', 'ruby']);
    });

    it('drops a group without touching the others', () => {
        const after = withGroup(three(), 'ruby', null);
        assert.deepEqual(after.groups, {});
    });
});

describe('editing metadata', () => {
    it('patches the fields it is given and keeps the rest', () => {
        const before = lyrics(three());
        const after = withMeta(before, { title: 'Song', offset: -250 });
        assert.equal(after.meta.title, 'Song');
        assert.equal(after.meta.offset, -250);
        assert.equal(after.meta.artist, '');
        assert.equal(before.meta.title, '');
    });

    it('returns the same lyrics when the patch changes nothing', () => {
        const before = lyrics(three());
        assert.equal(withMeta(before, { title: '' }), before);
        assert.equal(withMeta(before, { title: undefined }), before);
    });

    it('rejects a patch that cannot be stored', () => {
        assert.throws(
            () => withMeta(lyrics(three()), { offset: 1.5 }),
            (error) => own(error, 'invalid-lyrics-meta'),
        );
    });
});

describe('reading times back', () => {
    it('starts a piece at its check, then at its first derived character', () => {
        const tapped = withPiece(
            three(),
            { group: 'ruby', runIndex: 0, pieceIndex: 0 },
            {
                check: { time: 1_000, type: 'KeyDown' },
                text: textToStream('とう'),
            },
        );
        assert.equal(
            pieceStart(tapped, { group: 'ruby', runIndex: 0, pieceIndex: 0 }),
            1_000,
        );
        const derived = {
            offset: 0,
            length: 1,
            pieces: [
                {
                    check: null,
                    text: {
                        cells: [
                            { text: 'あ', span: { start: 500, duration: 100 } },
                        ],
                    },
                },
            ],
        };
        assert.equal(
            pieceStart(line('あ\n', { other: [derived] }), {
                group: 'other',
                runIndex: 0,
                pieceIndex: 0,
            }),
            500,
        );
        assert.equal(
            pieceStart(three(), { group: 'ruby', runIndex: 0, pieceIndex: 0 }),
            null,
        );
    });

    it('starts a run at its first piece that has a start', () => {
        const derived = {
            offset: 0,
            length: 1,
            pieces: [
                { check: null, text: textToStream('') },
                {
                    check: { time: 700, type: 'KeyDown' },
                    text: textToStream('あ'),
                },
            ],
        };
        assert.equal(
            runStart(line('あ\n', { other: [derived] }), 'other', 0),
            700,
        );
        assert.equal(runStart(three(), 'ruby', 9), null);
    });

    it('measures a line from its first timed cell to the last one', () => {
        const cells = [
            { text: 'あ', span: { start: 100, duration: 200 } },
            { text: 'い', span: { start: 300, duration: 400 } },
            { text: '\n', span: null },
        ];
        assert.deepEqual(lineSpan({ baseStream: { cells }, groups: {} }), {
            start: 100,
            duration: 600,
        });
        assert.equal(lineSpan(three()), null);
    });
});
