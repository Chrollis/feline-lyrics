// Force-align known lyrics to a track with a Whisper ONNX pair.
//
//   npm run build
//   node examples/align.mjs <model-dir> <audio> <lyrics.txt> [--ffmpeg <path>] [--language ja] [--out <file.json>]
//
// <model-dir> is a directory holding `onnx/encoder_model.onnx`,
// `onnx/decoder_model_merged.onnx` and the four JSON files, as exported by
// Xenova (transformers.js). Everything the alignment needs to know about the
// model comes from those files; nothing is hard coded here.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { align, openModel } from '../out/main/index.js';

const SETTINGS = [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
];

const args = process.argv.slice(2);

function option(name, fallback = null) {
    const index = args.indexOf(name);
    if (index === -1) {
        return fallback;
    }
    const value = args[index + 1];
    if (value === undefined) {
        throw new Error(`${name} needs a value`);
    }
    args.splice(index, 2);
    return value;
}

const ffmpeg = option('--ffmpeg', 'ffmpeg');
const language = option('--language', 'en');
const outArg = option('--out', null);
const [modelDir, audioPath, lyricsPath] = args;

if (
    modelDir === undefined ||
    audioPath === undefined ||
    lyricsPath === undefined
) {
    console.error(
        'usage: node examples/align.mjs <model-dir> <audio> <lyrics.txt> [--ffmpeg <path>] [--language ja] [--out <file.json>]',
    );
    process.exit(2);
}

// 16 kHz mono is what the encoder eats; the package would resample for us, but
// asking ffmpeg for the right rate keeps the example at one conversion.
function decode(path) {
    const raw = execFileSync(
        ffmpeg,
        [
            '-v',
            'error',
            '-i',
            path,
            '-map',
            'a:0',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-f',
            'f32le',
            '-',
        ],
        { maxBuffer: 1 << 30 },
    );
    const samples = new Float32Array(raw.length / 4);
    for (let index = 0; index < samples.length; index += 1) {
        samples[index] = raw.readFloatLE(index * 4);
    }
    return { sampleRate: 16000, channels: [samples] };
}

const root = resolve(modelDir);
const settings = {};
for (const name of SETTINGS) {
    settings[name] = readFileSync(join(root, name), 'utf8');
}

const handle = await openModel({
    id: basename(root),
    sessions: {
        encoder: { path: join(root, 'onnx', 'encoder_model.onnx') },
        decoder: { path: join(root, 'onnx', 'decoder_model_merged.onnx') },
    },
    executionProviders: ['cpu'],
    settings,
});

try {
    const audio = decode(audioPath);
    const result = await align(audio, handle, {
        text: readFileSync(lyricsPath, 'utf8'),
        language,
        onProgress: (progress) => {
            process.stderr.write(
                `${progress.seconds.toFixed(1)} / ${progress.totalSeconds.toFixed(1)} s\n`,
            );
        },
    });

    const outPath = resolve(
        outArg ??
            join(
                dirname(audioPath),
                `${basename(audioPath, '.mp3')}.timing.json`,
            ),
    );
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

    const words = result.segments.flatMap((segment) => segment.words);
    console.log(
        `${words.length} word(s) in ${result.segments.length} segment(s) -> ${outPath}`,
    );
    for (const word of words.slice(0, 5)) {
        console.log(
            `  ${word.start.toFixed(2)}-${word.end.toFixed(2)}  p=${word.probability.toFixed(3)}  ${JSON.stringify(word.word)}`,
        );
    }
} finally {
    await handle.release();
}
