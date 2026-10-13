import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEMUCS_SHIFTS,
    inspectDemucs,
    openModel,
    separate,
} from '../../out/main/index.js';

const CODECS = { flac: 'flac', wav: 'pcm_s16le', mp3: 'libmp3lame' };

const here = dirname(fileURLToPath(import.meta.url));
const started = Date.now();

function secondsSince(mark) {
    return `${((Date.now() - mark) / 1000).toFixed(1)}s`;
}

function run(command, args, input) {
    const result = spawnSync(command, args, { input, maxBuffer: 1 << 30 });
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
        '2',
        '-ar',
        String(sampleRate),
        '-',
    ]);
    return toFloat32(stdout);
}

function deinterleave(interleaved, frames) {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
        left[frame] = interleaved[frame * 2];
        right[frame] = interleaved[frame * 2 + 1];
    }
    return [left, right];
}

function interleave(channels) {
    const frames = channels[0].length;
    const samples = new Float32Array(frames * 2);
    for (let frame = 0; frame < frames; frame += 1) {
        samples[frame * 2] = channels[0][frame];
        samples[frame * 2 + 1] = channels[1][frame];
    }
    return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function encode(ffmpeg, samples, sampleRate, codec, outPath) {
    run(
        ffmpeg,
        [
            '-v',
            'error',
            '-y',
            '-f',
            'f32le',
            '-ar',
            String(sampleRate),
            '-ac',
            '2',
            '-i',
            'pipe:0',
            '-c:a',
            codec,
            outPath,
        ],
        samples,
    );
}

function reconstructionError(stems, mix) {
    const frames = mix[0].length;
    const sums = [new Float32Array(frames), new Float32Array(frames)];
    for (const stem of stems) {
        for (let index = 0; index < 2; index += 1) {
            const channel = stem.audio.channels[index];
            const limit = Math.min(frames, channel.length);
            for (let frame = 0; frame < limit; frame += 1) {
                sums[index][frame] += channel[frame];
            }
        }
    }
    let worst = 0;
    for (let index = 0; index < 2; index += 1) {
        for (let frame = 0; frame < frames; frame += 1) {
            const difference = Math.abs(sums[index][frame] - mix[index][frame]);
            worst = Math.max(worst, difference);
        }
    }
    return worst;
}

const args = process.argv.slice(2);
let modelPath;
let inputPath;
let ffmpeg = 'ffmpeg';
let outDir;
let shifts = DEMUCS_SHIFTS;
let format = 'flac';
let providers = ['webgpu', 'cpu'];
let modelRate = false;

for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--ffmpeg') {
        index += 1;
        ffmpeg = args[index];
    } else if (arg === '--out') {
        index += 1;
        outDir = args[index];
    } else if (arg === '--shifts') {
        index += 1;
        shifts = Number(args[index]);
    } else if (arg === '--format') {
        index += 1;
        format = args[index];
    } else if (arg === '--cpu') {
        providers = ['cpu'];
    } else if (arg === '--model-rate') {
        modelRate = true;
    } else if (arg.startsWith('--')) {
        throw new Error(`unknown option ${arg}`);
    } else if (modelPath === undefined) {
        modelPath = arg;
    } else if (inputPath === undefined) {
        inputPath = arg;
    } else {
        throw new Error(`unexpected argument ${arg}`);
    }
}

if (modelPath === undefined || inputPath === undefined) {
    throw new Error(
        'usage: node scripts/separate-song.mjs <model.onnx> <audio> ' +
            '[--ffmpeg <path>] [--out <dir>] [--shifts <n>] ' +
            '[--format flac|wav|mp3] [--cpu] [--model-rate]',
    );
}

const codec = CODECS[format];
if (codec === undefined) {
    throw new Error(`unknown format ${format}, expected flac, wav or mp3`);
}

const info = probe(probePath(ffmpeg), inputPath);
console.log(`input ${inputPath}: ${info.sampleRate} Hz, ${info.channels}ch`);

const bytes = await readFile(modelPath);
const handle = await openModel({
    id: basename(modelPath, '.onnx'),
    sessions: { model: { bytes } },
    executionProviders: providers,
});
console.log(
    `opened ${basename(modelPath)} (${bytes.byteLength} bytes) on ` +
        `${providers.join('+')} in ${secondsSince(started)}`,
);

try {
    // Decoding at the model rate makes both resample() calls no-ops, which is
    // what an application does when it prepares PCM before calling us.
    const decodeRate = modelRate
        ? inspectDemucs(handle).sampleRate
        : info.sampleRate;
    if (modelRate) {
        console.log(`decoding at the model rate ${decodeRate} Hz`);
    }

    const decoded = decode(ffmpeg, inputPath, decodeRate);
    const frames = Math.floor(decoded.length / 2);
    const mix = deinterleave(decoded, frames);
    console.log(`decoded ${frames} frames in ${secondsSince(started)}`);

    const separationStarted = Date.now();
    let reported = false;
    const stems = await separate(
        { sampleRate: decodeRate, channels: mix },
        handle,
        {
            shifts,
            onProgress(event) {
                const elapsed = (Date.now() - separationStarted) / 1000;
                const fraction =
                    event.total === 0 ? 1 : event.completed / event.total;
                const eta =
                    fraction > 0
                        ? (elapsed * (1 - fraction)) / fraction
                        : undefined;
                const text =
                    `  ${event.stage} ${event.completed}/${event.total} ` +
                    `${(fraction * 100).toFixed(0)}% elapsed ` +
                    `${elapsed.toFixed(1)}s eta ` +
                    `${eta === undefined ? '--' : eta.toFixed(1)}s`;
                process.stdout.write(
                    `\r${text}${' '.repeat(Math.max(0, 72 - text.length))}`,
                );
                reported = true;
            },
        },
    );
    if (reported) {
        process.stdout.write('\n');
    }
    console.log(
        `separated ${stems.length} stems (${shifts} shift(s)) in ` +
            `${secondsSince(separationStarted)}`,
    );
    console.log(
        `sum of stems vs input: worst ${reconstructionError(stems, mix)}`,
    );

    const name = basename(inputPath, extname(inputPath));
    const directory = outDir ?? resolve(here, '../../../../output', name);
    mkdirSync(directory, { recursive: true });
    for (const stem of stems) {
        const outPath = join(directory, `${stem.track}.${format}`);
        encode(
            ffmpeg,
            interleave(stem.audio.channels),
            stem.audio.sampleRate,
            codec,
            outPath,
        );
        console.log(`wrote ${outPath}`);
    }
    console.log(`done in ${secondsSince(started)}`);
} finally {
    await handle.release();
}
