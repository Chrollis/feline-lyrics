// Separate a track into stems with a Demucs ONNX export.
//
//   npm run build
//   node examples/separate.mjs <model.onnx> <audio> [--ffmpeg <path>] [--out <dir>]
//
// The package deals in samples only: it never opens a file and never decodes
// audio. This script does both, which is exactly the split the library expects
// from a caller.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openModel, separate } from '../out/main/index.js';

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
const outArg = option('--out', null);
const [modelPath, audioPath] = args;

if (modelPath === undefined || audioPath === undefined) {
    console.error(
        'usage: node examples/separate.mjs <model.onnx> <audio> [--ffmpeg <path>] [--out <dir>]',
    );
    process.exit(2);
}

const ffprobe = join(
    dirname(ffmpeg),
    process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
);

function probe(path) {
    const text = execFileSync(
        ffprobe,
        [
            '-v',
            'error',
            '-select_streams',
            'a:0',
            '-show_entries',
            'stream=sample_rate',
            '-of',
            'json',
            path,
        ],
        { encoding: 'utf8', maxBuffer: 1 << 20 },
    );
    return Number(JSON.parse(text).streams[0].sample_rate);
}

function decode(path) {
    const sampleRate = probe(path);
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
            '2',
            '-ar',
            String(sampleRate),
            '-f',
            'f32le',
            '-',
        ],
        { maxBuffer: 1 << 30 },
    );
    const frames = raw.length / 8;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
        left[frame] = raw.readFloatLE(frame * 8);
        right[frame] = raw.readFloatLE(frame * 8 + 4);
    }
    return { sampleRate, channels: [left, right] };
}

function toWav(pcm) {
    const channelCount = pcm.channels.length;
    const frames = pcm.channels[0].length;
    const dataBytes = frames * channelCount * 4;
    const buffer = Buffer.alloc(44 + dataBytes);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write('WAVEfmt ', 8, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(3, 20);
    buffer.writeUInt16LE(channelCount, 22);
    buffer.writeUInt32LE(pcm.sampleRate, 24);
    buffer.writeUInt32LE(pcm.sampleRate * channelCount * 4, 28);
    buffer.writeUInt16LE(channelCount * 4, 32);
    buffer.writeUInt16LE(32, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataBytes, 40);
    let offset = 44;
    for (let frame = 0; frame < frames; frame += 1) {
        for (const channel of pcm.channels) {
            buffer.writeFloatLE(channel[frame], offset);
            offset += 4;
        }
    }
    return buffer;
}

const audio = decode(audioPath);
const outDir = resolve(outArg ?? join(dirname(audioPath), 'stems'));

const handle = await openModel({
    id: 'htdemucs',
    sessions: { model: { path: resolve(modelPath) } },
    executionProviders: ['webgpu', 'cpu'],
});

try {
    const stems = await separate(audio, handle, {
        onProgress: (progress) => {
            if (
                progress.completed === 0 ||
                progress.completed === progress.total
            ) {
                process.stderr.write(
                    `chunk ${progress.completed}/${progress.total}\n`,
                );
            }
        },
    });
    mkdirSync(outDir, { recursive: true });
    for (const stem of stems) {
        const file = join(outDir, `${stem.track}.wav`);
        writeFileSync(file, toWav(stem.audio));
        console.log(
            `${file}  ${stem.audio.channels.length} ch  ${stem.audio.sampleRate} Hz`,
        );
    }
} finally {
    await handle.release();
}
