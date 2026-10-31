import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    CONTENT_KEYS,
    contentKeys,
    contentProblem,
    defaultContent,
    isStyleSpace,
    isValidContent,
    mergeContent,
    STYLE_SPACES,
} from '../../src/main/lyrics/stylecontent.js';

const solid = (color) => ({ kind: 'solid', color });

const gradient = () => ({
    kind: 'gradient',
    angleDeg: 90,
    stops: [
        { position: 0, color: '#ff0000' },
        { position: 1, color: '#0000ff' },
    ],
    smooth: true,
});

const character = () => ({
    font: { cjk: ['Noto Serif CJK'], latin: ['Source Serif'] },
    sizePx: 64,
    weight: 700,
    italic: true,
    letterSpacingPx: 1.5,
    baselineShiftPx: -2,
    fill: { normal: solid('#222222'), active: solid('#ffcc00') },
    wipe: { direction: 'ltr', transition: 'smooth', featherPx: 2 },
    outlines: [{ fill: { normal: solid('#000000') }, widthPx: 3, blurPx: 0 }],
    shadow: null,
});

describe('a style content', () => {
    it('defaults are complete for every space', () => {
        for (const space of STYLE_SPACES) {
            const content = defaultContent(space);
            const keys = Object.keys(content).sort();
            assert.deepEqual(keys, [...contentKeys(space)].sort());
            assert.equal(contentProblem(space, content), null);
        }
    });

    it('the character default has no second fill and no sweep', () => {
        const content = defaultContent('character');
        assert.equal(content.fill.active, undefined);
        assert.equal(content.wipe.direction, 'none');
        assert.deepEqual(content.outlines, []);
        assert.equal(content.shadow, null);
    });

    it('accepts a complete character content', () => {
        assert.equal(contentProblem('character', character()), null);
    });

    it('names the space when a key belongs to another one', () => {
        assert.equal(
            contentProblem('run', { sizePx: 12 }),
            'sizePx: is not a field of a run style',
        );
        assert.equal(
            contentProblem('character', { align: 'center' }),
            'align: is not a field of a character style',
        );
    });

    it('rejects a value that is not an object', () => {
        assert.equal(contentProblem('run', []), 'is not an object');
        assert.equal(contentProblem('run', 'x'), 'is not an object');
        assert.equal(contentProblem('run', null), 'is not an object');
    });

    it('checks the colour grammar', () => {
        const bad = { ...character(), fill: { normal: solid('red') } };
        assert.equal(
            contentProblem('character', bad),
            'fill.normal.color: is not a colour',
        );
        const short = { ...character(), fill: { normal: solid('#fff') } };
        assert.equal(
            contentProblem('character', short),
            'fill.normal.color: is not a colour',
        );
        const alpha = { ...character(), fill: { normal: solid('#ff000080') } };
        assert.equal(contentProblem('character', alpha), null);
    });

    it('keeps weight inside the hundred steps', () => {
        for (const weight of [99, 901, 450.5, '700']) {
            const bad = { ...character(), weight };
            assert.equal(
                contentProblem('character', bad),
                'weight: is not an integer from 100 to 900',
            );
        }
        assert.equal(contentProblem('character', { weight: 100 }), null);
        assert.equal(contentProblem('character', { weight: 900 }), null);
    });

    it('wants two stops at increasing positions for a gradient', () => {
        const one = {
            ...character(),
            fill: { normal: { ...gradient(), stops: [gradient().stops[0]] } },
        };
        assert.equal(
            contentProblem('character', one),
            'fill.normal.stops: is not an array of two stops or more',
        );
        const flat = {
            ...character(),
            fill: {
                normal: {
                    ...gradient(),
                    stops: [gradient().stops[1], gradient().stops[0]],
                },
            },
        };
        assert.equal(
            contentProblem('character', flat),
            'fill.normal.stops[1].position: is not past the stop before it',
        );
        const noSmooth = {
            ...character(),
            fill: { normal: { ...gradient(), smooth: undefined } },
        };
        assert.equal(
            contentProblem('character', noSmooth),
            'fill.normal.smooth: is missing',
        );
        assert.equal(
            contentProblem('character', { fill: { normal: gradient() } }),
            null,
        );
    });

    it('refuses an image fill by naming what is missing', () => {
        const image = {
            ...character(),
            fill: { normal: { kind: 'image', url: 'crl://a' } },
        };
        assert.match(
            contentProblem('character', image),
            /image fills need the resource system/,
        );
    });

    it('takes an empty list of outlines but not an empty layer', () => {
        assert.equal(contentProblem('character', { outlines: [] }), null);
        assert.equal(
            contentProblem('character', { outlines: 'none' }),
            'outlines: is not an array',
        );
        assert.equal(
            contentProblem('character', { outlines: [{}] }),
            'outlines[0].fill: is missing',
        );
        assert.equal(
            contentProblem('character', {
                shadow: {
                    fill: { normal: solid('#000000') },
                    offsetXPx: 1,
                    offsetYPx: 2,
                    blurPx: 0,
                },
            }),
            null,
        );
        assert.equal(
            contentProblem('character', {
                shadow: {
                    fill: { normal: solid('#000000') },
                    offsetXPx: 1,
                    blurPx: 0,
                },
            }),
            'shadow.offsetYPx: is missing',
        );
    });

    it('keeps the layers of an outline list in order', () => {
        const content = {
            outlines: [
                { fill: { normal: solid('#000000') }, widthPx: 6, blurPx: 0 },
                {
                    fill: {
                        normal: solid('#ff0000'),
                        active: solid('#ffffff'),
                    },
                    widthPx: 2,
                    blurPx: 1,
                },
            ],
        };
        assert.equal(contentProblem('character', content), null);
        assert.equal(content.outlines.length, 2);
        assert.deepEqual(
            content.outlines.map((layer) => layer.widthPx),
            [6, 2],
        );
    });

    it('checks every outline layer, not only the first', () => {
        const content = {
            outlines: [
                { fill: { normal: solid('#000000') }, widthPx: 6, blurPx: 0 },
                { fill: { normal: solid('#ff0000') }, widthPx: 0, blurPx: 0 },
            ],
        };
        assert.equal(
            contentProblem('character', content),
            'outlines[1].widthPx: is not a positive number',
        );
    });

    it('refuses the singular key it used to take', () => {
        assert.equal(
            contentProblem('character', {
                outline: { fill: { normal: solid('#000000') } },
            }),
            'outline: is not a field of a character style',
        );
    });

    it('checks the wipe direction and transition', () => {
        const content = {
            ...character(),
            wipe: { direction: 'diagonal', transition: 'linear', featherPx: 0 },
        };
        assert.equal(
            contentProblem('character', content),
            "wipe.direction: is not 'ltr', 'rtl', 'ttb', 'btt' or 'none'",
        );
        const eased = {
            ...character(),
            wipe: { direction: 'rtl', transition: 'springy', featherPx: 0 },
        };
        assert.equal(
            contentProblem('character', eased),
            "wipe.transition: is not 'linear' or 'smooth'",
        );
        const negative = {
            ...character(),
            wipe: { direction: 'rtl', transition: 'linear', featherPx: -1 },
        };
        assert.equal(
            contentProblem('character', negative),
            'wipe.featherPx: is not a number of 0 or more',
        );
    });

    it('lets a paragraph justify where a run may not', () => {
        assert.equal(contentProblem('paragraph', { align: 'justify' }), null);
        assert.equal(
            contentProblem('run', { align: 'justify' }),
            "align: is not 'left', 'center' or 'right'",
        );
        assert.equal(
            contentProblem('paragraph', { lineHeight: 0 }),
            'lineHeight: is not a positive number',
        );
    });

    it('merges top-level fields and never merges objects', () => {
        const base = defaultContent('character');
        const merged = mergeContent(base, {
            sizePx: 72,
            fill: { normal: solid('#123456') },
        });
        assert.equal(merged.sizePx, 72);
        assert.deepEqual(merged.fill, { normal: solid('#123456') });
        assert.equal(merged.weight, 400, 'absent fields keep the base value');

        const skipped = mergeContent(base, { sizePx: undefined });
        assert.equal(skipped.sizePx, 48, 'undefined is absent, not a value');
    });

    it('does not mutate the content it merges', () => {
        const base = Object.freeze({ ...defaultContent('run') });
        const merged = mergeContent(base, { position: 'below' });
        assert.equal(merged.position, 'below');
        assert.equal(base.position, 'above');
    });

    it('tells the three spaces apart', () => {
        assert.equal(isStyleSpace('character'), true);
        assert.equal(isStyleSpace('Character'), false);
        assert.equal(isStyleSpace(undefined), false);
        assert.deepEqual(
            [...CONTENT_KEYS.run],
            ['align', 'distancePx', 'position'],
        );
    });

    it('answers both ways about the same value', () => {
        assert.equal(isValidContent('character', character()), true);
        assert.equal(isValidContent('character', { weight: 0 }), false);
    });
});
