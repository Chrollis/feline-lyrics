import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportTagText, importTagText } from '../../src/main/io/tagtext.js';
import { decodeText } from '../../src/main/io/text.js';
import { lyricsToText } from '../../src/main/lyrics/lyrics.js';

/** Files shipped by the reference projects, used as realistic input. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SAMPLES = [
    'reference/NicoKaraMaker3/Documents/ja-JP/Samples/%E6%95%85%E9%83%B7.lrc',
    'reference/NicoKaraMaker3/Documents/ja-JP/Samples/%E6%95%85%E9%83%B7_%E3%82%B3%E3%83%BC%E3%83%A9%E3%82%B9.lrc',
    'reference/NicoKaraMaker3/Documents/en-US/Samples/Twinkle.lrc',
    'reference/whisper/test/original.lrc',
].map((relative) => ROOT + relative);

function load(path, importer) {
    const decoded = decodeText(readFileSync(path));
    return { decoded, ...importer(decoded.text) };
}

describe('reference samples', () => {
    for (const path of SAMPLES) {
        const name = path.split(/[\\/]/).pop();
        it(`round trips ${name}`, (t) => {
            if (!existsSync(path)) {
                t.skip('sample is not in this checkout');
                return;
            }
            const first = load(path, importTagText);
            // Real files carry stanza breaks, which the model has no field for
            // and reports rather than hides. Everything else must be clean.
            const expected = (loss) =>
                loss.detail !==
                    'the line was tagged but no cell could be timed, so its text carries no start' &&
                !/stanza break\(s\) dropped/.test(loss.detail);
            assert.deepEqual(first.losses.filter(expected), []);
            assert.ok(first.lyrics.lines.length > 0);

            const exported = exportTagText(first.lyrics);
            // A comma only has to go where an @Ruby parent covers it, and none
            // of these samples carries ruby, so nothing is dropped.
            assert.deepEqual(exported.losses, []);
            const second = importTagText(exported.text);
            assert.deepEqual(second.losses.filter(expected), []);

            assert.equal(
                lyricsToText(second.lyrics),
                lyricsToText(first.lyrics),
            );
            // A second export of the re-imported document is the same file.
            assert.equal(exportTagText(second.lyrics).text, exported.text);
        });
    }

    it('decodes the shift_jis sample without mojibake', (t) => {
        const path = SAMPLES[0];
        if (!existsSync(path)) {
            t.skip('sample is not in this checkout');
            return;
        }
        const { decoded, lyrics } = load(path, importTagText);
        assert.equal(decoded.encoding, 'shift_jis');
        assert.equal(
            lyrics.lines[0].baseStream.cells.map((cell) => cell.text).join(''),
            '＿兎追ひし彼の山\r\n',
        );
    });
});
