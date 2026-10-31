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
const PYPROJECT = path.join(ROOT, 'services', 'pyproject.toml');
const PIP_CACHE_DIR = path.join(CACHE_DIR, 'pip');

// ============================================================
// CONSTANTS
// ============================================================
const PBS_RELEASE_TAG = '20261001';
const PBS_PYTHON_VERSION = '3.12.15';
const PBS_FILENAME = `cpython-${PBS_PYTHON_VERSION}+${PBS_RELEASE_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`;

// const PBS_DOWNLOAD_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE_TAG}/${PBS_FILENAME}`;
// const PBS_DOWNLOAD_URL = 'https://gh-proxy.com/https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE_TAG}/${PBS_FILENAME}';
// const PBS_DOWNLOAD_URL = `https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/${PBS_RELEASE_TAG}/${PBS_FILENAME}`;
const PBS_DOWNLOAD_URL = `https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/${PBS_RELEASE_TAG}/${PBS_FILENAME}`;

const PIP_INDEX_URL = 'https://mirrors.cloud.tencent.com/pypi/simple/';
// const PIP_INDEX_URL = 'https://pypi.org/simple';

const PBS_CACHE = path.join(CACHE_DIR, PBS_FILENAME);
// The marker is written only once a whole extraction succeeded and the .pth is
// in place, so a half-extracted runtime is never mistaken for a ready one.
const READY_MARKER = path.join(RUNTIME_DIR, '.ready');
const READY_MARKER_CONTENT = PBS_FILENAME;

// A body sent without content-length ("chunked") cannot be checked against a
// byte count, so the only cheap floor left is that no real release archive is
// this small. A body cut to a few bytes still completes the pipeline.
const MIN_DOWNLOAD_BYTES = 1024 ** 2;

const BACKEND_PATH = '..\\..\\..\\services';
const PTH_FILE = path.join(RUNTIME_DIR, 'Lib', 'site-packages', 'felyrics.pth');

const IMPORT_NAME = 'felyrics';
const ISOLATION_CHECK =
    'import sys; ' +
    "leak = [p for p in sys.path if 'AppData' in p or 'Roaming' in p]; " +
    "print('sys.path ='); " +
    "[print('  ' + p) for p in sys.path]; " +
    "print('leaked user site:', leak); " +
    'sys.exit(1 if leak else 0)';

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
    if (r.status === null) {
        throw new Error(`${cmd} was killed by ${r.signal ?? 'a signal'}`);
    }
    return r.status;
}

function runCapture(cmd, args, { env } = {}) {
    const r = spawnSync(cmd, args, {
        env: env ?? process.env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) throw r.error;
    if (r.status === null) {
        throw new Error(`${cmd} was killed by ${r.signal ?? 'a signal'}`);
    }
    return { code: r.status, stdout: r.stdout ?? '' };
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

            // The mirror in front of this URL is external: a body cut short
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

const normalizeName = (n) =>
    n
        .replace(/[-_.]+/g, '-')
        .trim()
        .toLowerCase();

function distName(spec) {
    const m = spec.trim().match(/^[A-Za-z0-9._-]+/);
    if (!m) throw new Error(`cannot parse requirement: ${spec}`);
    return normalizeName(m[0]);
}

// ============================================================
// 1) setup_runtime
// ============================================================

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

function isReady() {
    if (!fs.existsSync(PYTHON)) return false;
    if (!fs.existsSync(path.join(RUNTIME_DIR, 'Lib', 'site-packages', 'pip'))) {
        return false;
    }
    // python.exe plus pip can still be a leftover of a half-extracted archive,
    // so the marker written at the end of a successful extraction is required.
    try {
        return (
            fs.readFileSync(READY_MARKER, 'utf-8').trim() ===
            READY_MARKER_CONTENT
        );
    } catch {
        return false;
    }
}

function cleanRuntime() {
    if (fs.existsSync(RUNTIME_DIR)) {
        log(`removing ${RUNTIME_DIR}`);
        fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
    }
}

function writePth() {
    fs.writeFileSync(PTH_FILE, BACKEND_PATH + '\n', 'utf-8');
}

function unzip(zipPath, dest) {
    requireTar();
    // List first, but only a real non-zero exit means the archive is bad: a
    // failed spawn or a killed tar must keep the archive for the next run.
    const probe = spawnSync('tar', ['-tf', zipPath], { stdio: 'ignore' });
    if (probe.error || probe.status === null) {
        throw new Error(
            `could not list ${path.basename(zipPath)} ` +
                `(${probe.error?.message ?? `tar was killed by ${probe.signal ?? 'a signal'}`}); ` +
                'no archive was removed',
        );
    }
    if (probe.status !== 0) {
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

async function buildRuntime() {
    log('[1/3] downloading python-build-standalone');
    if (!fs.existsSync(PBS_CACHE)) {
        await download(PBS_DOWNLOAD_URL, PBS_CACHE);
    }

    log('[2/3] extracting runtime');
    unzip(PBS_CACHE, ROOT);

    log('[3/3] configuring paths');
    writePth();
    // Last step: an extraction that dies in the middle leaves no marker, so
    // isReady() rejects that tree and the next run extracts again.
    fs.writeFileSync(READY_MARKER, `${READY_MARKER_CONTENT}\n`, 'utf-8');
    log('done');
}

function writePipIni() {
    const text = `[global]\nindex-url = ${PIP_INDEX_URL}\n`;
    fs.writeFileSync(path.join(RUNTIME_DIR, 'pip.ini'), text, 'utf-8');
}

async function setupRuntime() {
    if (isReady()) {
        log('runtime already present');
    } else {
        cleanRuntime();
        await buildRuntime();
    }
    writePipIni();
    log(`pip.ini: index-url = ${PIP_INDEX_URL}`);
}

// ============================================================
// 2) install_deps
// ============================================================
function readDependencies() {
    if (!fs.existsSync(PYPROJECT)) {
        throw new Error(`cannot find ${PYPROJECT}`);
    }
    const text = fs.readFileSync(PYPROJECT, 'utf-8');

    const proj = text.match(/\[project\]([\s\S]*?)(?=\n\[|$)/);
    if (!proj) throw new Error(`${PYPROJECT} has no [project] section`);

    const arr = proj[1].match(
        /dependencies\s*=\s*\[([\s\S]*?)\]\s*(?:#[^\n]*)?$/m,
    );
    if (!arr) throw new Error(`${PYPROJECT} has no [project].dependencies`);

    const deps = [];
    for (const m of arr[1].matchAll(/"([^"]*)"|'([^']*)'/g)) {
        deps.push(m[1] ?? m[2]);
    }
    if (deps.length === 0)
        throw new Error(`${PYPROJECT} has empty dependencies`);
    return deps;
}

/**
 * The `dev` extras (test-only tooling). A pyproject without that section is
 * not an error: production runtimes are built without it.
 */
function readDevDependencies() {
    if (!fs.existsSync(PYPROJECT)) {
        throw new Error(`cannot find ${PYPROJECT}`);
    }
    const text = fs.readFileSync(PYPROJECT, 'utf-8');

    const group = text.match(
        /\[project\.optional-dependencies\]([\s\S]*?)(?=\n\[|$)/,
    );
    if (!group) return [];

    const arr = group[1].match(/^dev\s*=\s*\[([\s\S]*?)\]\s*(?:#[^\n]*)?$/m);
    if (!arr) return [];

    const deps = [];
    for (const m of arr[1].matchAll(/"([^"]*)"|'([^']*)'/g)) {
        deps.push(m[1] ?? m[2]);
    }
    return deps;
}

function listInstalled(env) {
    const { code, stdout } = runCapture(
        PYTHON,
        ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'],
        { env },
    );
    if (code !== 0) throw new Error(`pip list failed with exit code ${code}`);
    const data = JSON.parse(stdout || '[]');
    const map = {};
    for (const d of data) map[normalizeName(d.name)] = d.version;
    return map;
}

function installDeps({ prod = false } = {}) {
    const deps = readDependencies();
    const devDeps = prod ? [] : readDevDependencies();
    const specs = [...deps, ...devDeps];
    const env = pipEnv();

    if (prod) {
        log('mode: prod (dev extras skipped)');
    } else if (devDeps.length > 0) {
        log(`dev extras: ${devDeps.map((spec) => distName(spec)).join(', ')}`);
    }

    const rc = run(
        PYTHON,
        [
            '-m',
            'pip',
            'install',
            '--index-url',
            PIP_INDEX_URL,
            '--no-input',
            '--no-warn-script-location',
            ...specs,
        ],
        { env },
    );
    if (rc !== 0) return rc;

    const installed = listInstalled(env);
    console.log();
    log('installed:');
    const missing = [];
    for (const spec of specs) {
        const name = distName(spec);
        const version = installed[name];
        if (version === undefined) {
            console.log(`  ${name} MISSING`);
            missing.push(name);
        } else {
            console.log(`  ${name} ${version}`);
        }
    }
    if (missing.length) return 1;

    log('pip check:');
    return run(PYTHON, ['-m', 'pip', 'check'], { env });
}

// ============================================================
// 3) verify
// ============================================================
function verify() {
    if (!fs.existsSync(PYTHON)) {
        log(`failed: cannot find ${PYTHON}; run setup first`);
        return 1;
    }
    const env = pipEnv();
    const checks = [
        [
            'interpreter',
            ['-c', "import sys; print('python', sys.version.split()[0])"],
        ],
        ['pip', ['-m', 'pip', '--version']],
        ['pip config', ['-m', 'pip', 'config', 'list']],
        ['isolation', ['-c', ISOLATION_CHECK]],
        [
            `${IMPORT_NAME} importable`,
            [
                '-c',
                `import ${IMPORT_NAME}; print('${IMPORT_NAME} importable:', ${IMPORT_NAME}.__file__)`,
            ],
        ],
        ['pip check', ['-m', 'pip', 'check']],
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
async function main(argv = process.argv.slice(2)) {
    if (argv.includes('--print-deps')) {
        console.log(
            JSON.stringify(
                { runtime: readDependencies(), dev: readDevDependencies() },
                null,
                2,
            ),
        );
        return 0;
    }

    const prod = argv.includes('--prod');
    await setupRuntime();

    const installRc = installDeps({ prod });
    if (installRc !== 0) return installRc;

    return verify();
}

main()
    .then((rc) => process.exit(rc))
    .catch((err) => {
        log(`failed: ${err.message}`);
        process.exit(1);
    });
