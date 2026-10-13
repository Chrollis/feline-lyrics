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

function run(cmd, args, { env } = {}) {
    log(`> ${cmd} ${args.join(' ')}`);
    const r = spawnSync(cmd, args, {
        env: env ?? process.env,
        stdio: 'inherit',
    });
    if (r.error) throw r.error;
    return r.status ?? 0;
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

function unzip(zipPath, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const rc = run('tar', ['-xf', zipPath, '-C', dest]);
    if (rc !== 0) throw new Error('extract failed');
}

// ============================================================
// 1) setup_ffmpeg
// ============================================================
function ffmpegReady() {
    return fs.existsSync(
        path.join(FFMPEG_DIR, 'include', 'libavcodec', 'avcodec.h'),
    );
}

async function setupFFmpeg() {
    if (ffmpegReady()) {
        log('ffmpeg already present');
        return;
    }

    log('[ffmpeg] downloading');
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
