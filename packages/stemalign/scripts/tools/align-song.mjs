import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openModel, setOrtLogLevel } from '../../out/main/index.js';
import { align } from '../../out/main/alignment/align.js';
import { inspectWhisper } from '../../out/main/alignment/whisper.js';
import { inspectWhisperSettings } from '../../out/main/alignment/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
const started = Date.now();

function secondsSince(mark) {
    return `${((Date.now() - mark) / 1000).toFixed(1)}s`;
}

function run(command, args) {
    const result = spawnSync(command, args, { maxBuffer: 1 << 30 });
    if (result.error !== undefined) {
        throw new Error(`could not run ${command}: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} failed (${result.status}): ${String(result.stderr).trim()}`,
        );
    }
    return result.stdout;
}

function probePath(ffmpeg) {
    const directory = dirname(ffmpeg);
    const extension = extname(ffmpeg);
    const name = `ffprobe${extension}`;
    return directory === '.' ? name : join(directory, name);
}

function probe(ffprobe, input) {
    const output = String(
        run(ffprobe, [
            '-v',
            'error',
            '-select_streams',
            'a:0',
            '-show_entries',
            'stream=sample_rate,channels',
            '-of',
            'default=noprint_wrappers=1',
            input,
        ]),
    );
    const values = new Map(
        output
            .trim()
            .split('\n')
            .map((line) => line.split('=')),
    );
    return {
        sampleRate: Number(values.get('sample_rate')),
        channels: Number(values.get('channels')),
    };
}

function toFloat32(buffer) {
    const length = Math.floor(buffer.byteLength / 4);
    const samples = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
        samples[index] = buffer.readFloatLE(index * 4);
    }
    return samples;
}

function decode(ffmpeg, input, sampleRate) {
    const stdout = run(ffmpeg, [
        '-v',
        'error',
        '-i',
        input,
        '-map',
        'a:0',
        '-f',
        'f32le',
        '-acodec',
        'pcm_f32le',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-',
    ]);
    return toFloat32(stdout);
}

// Aligner._standardize_text with originalSplit = false (aligner.mjs:202-205):
// every whitespace character becomes a space, and the text gains a leading one.
function standardizeText(text) {
    const normalized = text.replace(/\s/g, ' ');
    return normalized.startsWith(' ') ? normalized : ` ${normalized}`;
}

const args = process.argv.slice(2);
let modelDir;
let inputPath;
let textPath;
let ffmpeg = 'ffmpeg';
let outPath;
let language = 'en';
let byPiece = false;
let providers = ['dml', 'cpu'];
let modelRate = false;

for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--ffmpeg') {
        index += 1;
        ffmpeg = args[index];
    } else if (arg === '--out') {
        index += 1;
        outPath = args[index];
    } else if (arg === '--language') {
        index += 1;
        language = args[index];
    } else if (arg === '--by-piece') {
        byPiece = true;
    } else if (arg === '--cpu') {
        providers = ['cpu'];
    } else if (arg === '--model-rate') {
        modelRate = true;
    } else if (arg.startsWith('--')) {
        throw new Error(`unknown option ${arg}`);
    } else if (modelDir === undefined) {
        modelDir = arg;
    } else if (inputPath === undefined) {
        inputPath = arg;
    } else if (textPath === undefined) {
        textPath = arg;
    } else {
        throw new Error(`unexpected argument ${arg}`);
    }
}

if (
    modelDir === undefined ||
    inputPath === undefined ||
    textPath === undefined
) {
    throw new Error(
        'usage: node scripts/align-song.mjs <model-dir> <audio> <lyrics.txt> ' +
            '[--ffmpeg <path>] [--out <file.json>] [--language <code>] ' +
            '[--by-piece] [--cpu] [--model-rate]',
    );
}

const info = probe(probePath(ffmpeg), inputPath);
console.log(`input ${inputPath}: ${info.sampleRate} Hz, ${info.channels}ch`);

const modelName = basename(resolve(modelDir));
const encoderPath = resolve(join(modelDir, 'onnx', 'encoder_model.onnx'));
const decoderPath = resolve(
    join(modelDir, 'onnx', 'decoder_model_merged.onnx'),
);

setOrtLogLevel('error');

const handle = await openModel({
    id: modelName,
    sessions: {
        encoder: { path: encoderPath },
        decoder: { path: decoderPath },
    },
    settings: {
        config: await readFile(join(modelDir, 'config.json'), 'utf8'),
        generation: await readFile(
            join(modelDir, 'generation_config.json'),
            'utf8',
        ),
        preprocessor: await readFile(
            join(modelDir, 'preprocessor_config.json'),
            'utf8',
        ),
        tokenizer: await readFile(join(modelDir, 'tokenizer.json'), 'utf8'),
    },
    executionProviders: providers,
});
console.log(
    `opened ${modelName} on ${providers.join('+')} in ${secondsSince(started)}`,
);

try {
    const settings = inspectWhisperSettings(handle, inspectWhisper(handle));
    const decodeRate = modelRate ? settings.sampleRate : info.sampleRate;
    if (modelRate) {
        console.log(`decoding at the model rate ${decodeRate} Hz`);
    }

    const samples = decode(ffmpeg, inputPath, decodeRate);
    console.log(`decoded ${samples.length} frames in ${secondsSince(started)}`);

    const text = standardizeText(await readFile(textPath, 'utf8'));
    console.log(`lyrics ${textPath}: ${text.length} chars`);

    const alignmentStarted = Date.now();
    let reported = false;
    const result = await align(
        { sampleRate: decodeRate, channels: [samples] },
        text,
        handle,
        {
            language,
            splitWordsBySpace: !byPiece,
            onProgress(event) {
                const elapsed = (Date.now() - alignmentStarted) / 1000;
                const fraction =
                    event.totalSeconds === 0
                        ? 1
                        : event.seconds / event.totalSeconds;
                const eta =
                    fraction > 0
                        ? (elapsed * (1 - fraction)) / fraction
                        : undefined;
                const line =
                    `  align ${event.seconds.toFixed(1)}s/` +
                    `${event.totalSeconds.toFixed(1)}s ` +
                    `${(fraction * 100).toFixed(0)}% elapsed ` +
                    `${elapsed.toFixed(1)}s eta ` +
                    `${eta === undefined ? '--' : eta.toFixed(1)}s`;
                process.stdout.write(
                    `\r${line}${' '.repeat(Math.max(0, 72 - line.length))}`,
                );
                reported = true;
            },
        },
    );
    if (reported) {
        process.stdout.write('\n');
    }

    const words = result.segments.flatMap((segment) => segment.words);
    console.log(
        `aligned ${words.length} words in ${secondsSince(alignmentStarted)}`,
    );
    const first = words[0];
    const last = words[words.length - 1];
    if (first !== undefined && last !== undefined) {
        console.log(
            `span ${first.start.toFixed(2)}s .. ${last.end.toFixed(2)}s`,
        );
    }

    const name = basename(inputPath, extname(inputPath));
    const target =
        outPath ??
        join(resolve(here, '../../../../output', name), `${name}.json`);
    mkdirSync(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(
        `wrote ${target} (${result.segments.length} segment(s), ${result.regroup_history ? 'regrouped' : 'flat'})`,
    );
    console.log(`done in ${secondsSince(started)}`);
} finally {
    await handle.release();
}
