import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ============================================================
// PATHS
// ============================================================
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const RUNTIME_DIR = path.join(ROOT, 'python');
const PYTHON = path.join(RUNTIME_DIR, 'python.exe');
const CACHE_DIR = path.join(ROOT, 'cache');
const TEMP_DIR = path.join(CACHE_DIR, 'temp');
const PIP_CACHE_DIR = path.join(CACHE_DIR, 'pip');

// ============================================================
// CONSTANTS
// ============================================================
const FFMPEG_FILENAME = 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip';
const FFMPEG_DOWNLOAD_URL = `https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_FILENAME}`;
// const FFMPEG_DOWNLOAD_URL = `https://mirror.nju.edu.cn/github-release/BtbN/FFmpeg-Builds/latest/${FFMPEG_FILENAME}`;

const FFMPEG_CACHE = path.join(CACHE_DIR, FFMPEG_FILENAME);
const FFMPEG_DIR = path.join(CACHE_DIR, 'ffmpeg');
const FFMPEG_BIN = path.join(FFMPEG_DIR, 'bin');
const FFMPEG_HEADER = path.join(
    FFMPEG_DIR,
    'include',
    'libavcodec',
    'avcodec.h',
);
// The marker is written only once a whole extraction (and the rename into
// place) succeeded, so a half-extracted tree is never mistaken for a ready one.
const FFMPEG_MARKER = path.join(FFMPEG_DIR, '.ready');

// A body sent without content-length ("chunked") cannot be checked against a
// byte count, so the only cheap floor left is that no real release archive is
// this small. A body cut to a few bytes still completes the pipeline.
const MIN_DOWNLOAD_BYTES = 1024 ** 2;

const BUILD_VENV = path.join(CACHE_DIR, '.venv');
const BUILD_PYTHON = path.join(BUILD_VENV, 'Scripts', 'python.exe');
const BUILD_DEPS = ['setuptools', 'wheel', 'cython', 'numpy', 'pytest'];

const WHEEL_DIR = path.join(CACHE_DIR, 'wheels');
const AV_PACKAGE = path.join(RUNTIME_DIR, 'Lib', 'site-packages', 'av');

// const PIP_INDEX_URL = 'https://mirrors.cloud.tencent.com/pypi/simple/';
// const PIP_INDEX_URL = 'https://pypi.org/simple';
const PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple';

// ============================================================
// TOOLS
// ============================================================
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

function run(cmd, args, { env, quiet = false } = {}) {
    log(`> ${cmd} ${args.join(' ')}`);
    const r = spawnSync(cmd, args, {
        env: env ?? process.env,
        stdio: quiet ? 'ignore' : 'inherit',
    });
    if (r.error) throw r.error;
    if (r.status === null) {
        throw new Error(`${cmd} was killed by ${r.signal ?? 'a signal'}`);
    }
    return r.status;
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function download(url, dest, { retries = 3 } = {}) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';

    for (let i = 1; i <= retries; i++) {
        let drew = false;
        try {
            log(`downloading ${path.basename(dest)} from ${url}`);

            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            if (!res.body) throw new Error('empty response body');

            const total = Number(res.headers.get('content-length')) || 0;
            const BAR = 30;
            const startedAt = Date.now();
            let received = 0;
            let lastPaint = 0;

            const paint = () => {
                const now = Date.now();
                if (now - lastPaint < 80 && (!total || received < total))
                    return;
                lastPaint = now;

                const secs = Math.max((now - startedAt) / 1000, 0.001);
                const speed = received / secs;

                let line;
                if (total) {
                    const pct = (received / total) * 100;
                    const filled = Math.min(BAR, Math.round((pct / 100) * BAR));
                    const bar = '█'.repeat(filled) + '░'.repeat(BAR - filled);
                    line =
                        `  ${bar} ${pct.toFixed(1).padStart(5)}%  ` +
                        `${formatBytes(received)} / ${formatBytes(total)}  ` +
                        `${formatBytes(speed)}/s`;
                } else {
                    line = `  ${formatBytes(received)}  ${formatBytes(speed)}/s`;
                }
                process.stderr.write(`\r${line}\x1b[K`);
                drew = true;
            };

            const src = Readable.fromWeb(res.body);
            src.on('data', (chunk) => {
                received += chunk.length;
                paint();
            });

            await pipeline(src, fs.createWriteStream(part));

            paint();
            if (drew) process.stderr.write('\n');

            // The mirrors in front of this URL are external: a body cut short
            // still completes the pipeline, and the next run trusts the file by
            // its existence, so the short read has to fail here and retry.
            if (total > 0 && received !== total) {
                throw new Error(
                    `received ${received} of ${total} bytes: the download was truncated`,
                );
            }
            // Without content-length the exact size is unknown, so at least
            // refuse the obviously truncated body instead of caching it.
            if (total === 0 && received < MIN_DOWNLOAD_BYTES) {
                throw new Error(
                    `received ${received} bytes with no content-length to check ` +
                        `against; anything under ${formatBytes(MIN_DOWNLOAD_BYTES)} ` +
                        'is treated as truncated',
                );
            }

            fs.renameSync(part, dest);
            log(`  -> ${dest} (${received} bytes)`);
            return;
        } catch (err) {
            if (drew) process.stderr.write('\n');
            try {
                fs.unlinkSync(part);
            } catch {
                // catch nothing
            }
            log(`attempt ${i}/${retries} failed: ${err.message}`);
            if (i === retries) throw err;
        }
    }
}

function pipEnv() {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (k.toUpperCase().startsWith('PIP_')) continue;
        env[k] = v;
    }
    env.TEMP = TEMP_DIR;
    env.TMP = TEMP_DIR;
    env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
    env.PYTHONNOUSERSITE = '1';
    env.PIP_CACHE_DIR = PIP_CACHE_DIR;
    return env;
}

// Windows ships bsdtar and macOS ships tar, but PATH can still have none. The
// probe runs before the archive is touched: a missing tar must not delete the
// archive, and spawnSync's own "spawn tar ENOENT" says nothing useful.
function requireTar() {
    const r = spawnSync('tar', ['--version'], { stdio: 'ignore' });
    if (r.error) {
        throw new Error(
            'tar/bsdtar is required to extract archives but could not be run ' +
                `(${r.error.message}); no archive was removed`,
        );
    }
    if (r.status !== 0) {
        throw new Error(
            'tar/bsdtar is required to extract archives but ' +
                `'tar --version' exited with ${r.status}; no archive was removed`,
        );
    }
}

function unzip(zipPath, dest) {
    requireTar();
    // List first: an archive that cannot even be listed is unusable, and the
    // next run would keep failing on it because it trusts existence alone.
    if (run('tar', ['-tf', zipPath], { quiet: true }) !== 0) {
        fs.rmSync(zipPath, { force: true });
        throw new Error(
            `extract failed: ${path.basename(zipPath)} could not be listed and was removed`,
        );
    }
    fs.mkdirSync(dest, { recursive: true });
    const rc = run('tar', ['-xf', zipPath, '-C', dest]);
    if (rc !== 0) {
        // The next run trusts the archive by its existence alone, so a bad one
        // has to go or every later run fails in the same place.
        fs.rmSync(zipPath, { force: true });
        throw new Error(
            `extract failed (tar exit ${rc}): ${path.basename(zipPath)} was removed`,
        );
    }
}

// ============================================================
// 1) setup_ffmpeg
// ============================================================
function readMarker(markerPath) {
    try {
        return fs.readFileSync(markerPath, 'utf-8').trim();
    } catch {
        return null;
    }
}

function ffmpegReady() {
    // Existence of one header is not proof of a finished extraction, so the
    // marker (written last, by setupFFmpeg) plus the files the next steps need
    // are checked together.
    if (readMarker(FFMPEG_MARKER) !== FFMPEG_FILENAME) return false;
    if (!fs.existsSync(FFMPEG_HEADER)) return false;
    if (!fs.existsSync(FFMPEG_BIN)) return false;
    return fs
        .readdirSync(FFMPEG_BIN)
        .some((f) => f.toLowerCase().endsWith('.dll'));
}

async function setupFFmpeg() {
    if (ffmpegReady()) {
        log('ffmpeg already present');
        return;
    }

    log('[ffmpeg] downloading');
    // The archive itself decides: cache/ always exists, but a deleted archive
    // has to come back, so the test is on the zip path, never on the directory.
    if (!fs.existsSync(FFMPEG_CACHE)) {
        await download(FFMPEG_DOWNLOAD_URL, FFMPEG_CACHE);
    }

    log('[ffmpeg] extracting');
    unzip(FFMPEG_CACHE, CACHE_DIR);

    let inner = path.join(CACHE_DIR, path.parse(FFMPEG_FILENAME).name);
    if (!fs.existsSync(path.join(inner, 'bin'))) {
        const sub = fs
            .readdirSync(inner)
            .find((f) => fs.statSync(path.join(inner, f)).isDirectory());
        if (sub) inner = path.join(inner, sub);
    }

    fs.rmSync(FFMPEG_DIR, { recursive: true, force: true });
    fs.renameSync(inner, FFMPEG_DIR);
    // Last step, and only after the tree is in place: an extraction that dies
    // in the middle leaves no marker behind, so the next run extracts again.
    fs.writeFileSync(FFMPEG_MARKER, `${FFMPEG_FILENAME}\n`, 'utf-8');
    log(`  -> ${FFMPEG_DIR}`);
}

// ============================================================
// 2) setup_build_venv
// ============================================================
function setupBuildVenv() {
    if (fs.existsSync(BUILD_PYTHON)) {
        log('build venv already present');
    } else {
        log('[venv] creating');
        const rc = run(PYTHON, ['-m', 'venv', BUILD_VENV], { env: pipEnv() });
        if (rc !== 0) throw new Error(`venv creation failed (exit ${rc})`);
    }

    log('[venv] installing build deps');
    const rc = run(
        BUILD_PYTHON,
        [
            '-m',
            'pip',
            'install',
            '--index-url',
            PIP_INDEX_URL,
            '--no-input',
            '--no-warn-script-location',
            ...BUILD_DEPS,
        ],
        { env: pipEnv() },
    );
    if (rc !== 0) throw new Error(`build deps install failed (exit ${rc})`);
}

// ============================================================
// 3) build_pyav
// ============================================================
function findCachedWheel() {
    if (!fs.existsSync(WHEEL_DIR)) return null;
    const files = fs
        .readdirSync(WHEEL_DIR)
        .filter((f) => /^av-.*\.whl$/i.test(f))
        .sort();
    return files.length ? path.join(WHEEL_DIR, files[files.length - 1]) : null;
}

function buildPyAV() {
    const cached = findCachedWheel();
    if (cached) {
        log(`[pyav] using cached wheel: ${path.basename(cached)}`);
        return cached;
    }

    fs.mkdirSync(WHEEL_DIR, { recursive: true });

    log('[pyav] building wheel against lgpl ffmpeg');
    const rc = run(
        BUILD_PYTHON,
        [
            '-m',
            'pip',
            'wheel',
            'av',
            '--no-binary',
            'av',
            '--no-deps',
            '--no-build-isolation',
            '--index-url',
            PIP_INDEX_URL,
            '--no-input',
            '--disable-pip-version-check',
            '-w',
            WHEEL_DIR,
            '--config-settings=--build-option=build_ext',
            `--config-settings=--build-option=--ffmpeg-dir=${FFMPEG_DIR}`,
        ],
        { env: pipEnv() },
    );
    if (rc !== 0) throw new Error(`pyav wheel build failed (exit ${rc})`);

    const wheel = findCachedWheel();
    if (!wheel) throw new Error('pyav wheel not found after build');
    log(`  -> ${wheel}`);
    return wheel;
}

// ============================================================
// 4) install_pyav
// ============================================================
function installPyAV(wheel) {
    log('[pyav] installing into runtime');
    const rc = run(
        PYTHON,
        [
            '-m',
            'pip',
            'install',
            '--no-input',
            '--disable-pip-version-check',
            '--force-reinstall',
            '--no-deps',
            wheel,
        ],
        { env: pipEnv() },
    );
    if (rc !== 0) throw new Error(`pyav install failed (exit ${rc})`);
}

function copyFFmpegDlls() {
    log('[pyav] copying ffmpeg dlls');
    const dlls = fs
        .readdirSync(FFMPEG_BIN)
        .filter((f) => f.toLowerCase().endsWith('.dll'));
    for (const name of dlls) {
        const src = path.join(FFMPEG_BIN, name);
        fs.copyFileSync(src, path.join(RUNTIME_DIR, name));
        if (fs.existsSync(AV_PACKAGE)) {
            fs.copyFileSync(src, path.join(AV_PACKAGE, name));
        }
    }
    log(`  -> ${dlls.length} dlls`);
}

// ============================================================
// 5) verify
// ============================================================
function verify() {
    if (!fs.existsSync(PYTHON)) {
        log(`failed: cannot find ${PYTHON}; run python.mjs first`);
        return 1;
    }

    const env = pipEnv();
    const checks = [
        [
            'pyav',
            [
                '-c',
                'import av; ' +
                    "print('av', av.__version__); " +
                    "print('ffmpeg', av.ffmpeg_version_info)",
            ],
        ],
        [
            // The service encodes flac audio and png frames, so "av imports" is
            // not the question: each encoder has to build a context, open, and
            // take one frame. A build without the codec throws here.
            'pyav flac encoder',
            [
                '-c',
                'import av; ' +
                    "flac = av.codec.Codec('flac', 'w').create(); " +
                    'flac.sample_rate = 48000; ' +
                    "flac.format = 's16'; " +
                    "flac.layout = 'mono'; " +
                    'flac.open(); ' +
                    "frame = av.AudioFrame(format='s16', layout='mono', samples=512); " +
                    'frame.sample_rate = 48000; ' +
                    'flac.encode(frame); ' +
                    "print('flac ok')",
            ],
        ],
        [
            'pyav png encoder',
            [
                '-c',
                'import av; ' +
                    "png = av.codec.Codec('png', 'w').create(); " +
                    'png.width = 16; ' +
                    'png.height = 16; ' +
                    "png.pix_fmt = 'rgb24'; " +
                    'png.open(); ' +
                    "png.encode(av.VideoFrame(16, 16, 'rgb24')); " +
                    "print('png ok')",
            ],
        ],
        [
            'pyav lgpl',
            [
                '-c',
                'import av; ' +
                    "assert 'libx264' not in av.codecs_available, 'libx264 present'; " +
                    "assert 'libx265' not in av.codecs_available, 'libx265 present'; " +
                    "print('lgpl ok')",
            ],
        ],
    ];

    const failed = [];
    for (const [name, args] of checks) {
        log(`check: ${name}`);
        const rc = run(PYTHON, args, { env });
        if (rc !== 0) {
            log(`  failed: ${name} (exit code ${rc})`);
            failed.push(name);
        }
    }
    if (failed.length) {
        log(`verification failed: ${failed.join(', ')}`);
        return 1;
    }
    log('all checks passed');
    return 0;
}

// ============================================================
// main
// ============================================================
async function main() {
    if (!fs.existsSync(PYTHON)) {
        log(`failed: cannot find ${PYTHON}; run python.mjs first`);
        return 1;
    }

    await setupFFmpeg();
    setupBuildVenv();
    const wheel = buildPyAV();
    installPyAV(wheel);
    copyFFmpegDlls();

    return verify();
}

main()
    .then((rc) => process.exit(rc))
    .catch((err) => {
        log(`failed: ${err.message}`);
        process.exit(1);
    });
