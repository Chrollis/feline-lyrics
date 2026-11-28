// Smoke the packaged app: koffi's JS package must be inside app.asar and its
// native module must be unpacked and loadable. Run after `npm run dist:dir`.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESOURCES = path.join(
  ROOT,
  'apps',
  'desktop',
  'release',
  'win-unpacked',
  'resources',
);
const ASAR_PATH = path.join(RESOURCES, 'app.asar');
const NATIVE_PATH = path.join(
  RESOURCES,
  'app.asar.unpacked',
  'node_modules',
  '@koromix',
  'koffi-win32-x64',
  'win32_x64',
  'koffi.node',
);
const EXE_PATH = path.join(
  ROOT,
  'apps',
  'desktop',
  'release',
  'win-unpacked',
  'Felyrics.exe',
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);

    child.once('exit', (code, signal) => finish({ code, signal }));
    child.once('error', (error) => finish({ error }));
  });
}

/**
 * Runs the packaged self-test and returns its result text. The result file is
 * read before the exit status is judged, so a failure reason written by the app
 * survives in the thrown error even when the process exits non-zero.
 */
export async function runSelfTest({
  exePath = EXE_PATH,
  timeoutMs = 30_000,
  selfTestArgs = (dir) => ['--self-test=packaged-koffi', `--self-test-dir=${dir}`],
} = {}) {
  if (!existsSync(exePath)) {
    throw new Error(
      `the packaged executable is missing: ${exePath}; run \`npm.cmd run dist:dir\` first`,
    );
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'felyrics-self-test-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  );
  // The agent shell exports this; inherited, Electron would start as Node.
  delete env.ELECTRON_RUN_AS_NODE;

  let child;

  try {
    child = spawn(exePath, selfTestArgs(dir), {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    const outcome = await waitForExit(child, timeoutMs);
    const resultPath = path.join(dir, 'result.txt');
    const result = existsSync(resultPath)
      ? readFileSync(resultPath, 'utf8').trim()
      : undefined;
    const reason = result === undefined ? '' : `: ${result}`;
    const output = stderr.length > 0 ? `\n${stderr}` : '';

    if (outcome.error !== undefined) {
      throw new Error(
        `cannot start ${exePath}: ${outcome.error.message}${reason}${output}`,
      );
    }

    if (outcome.timedOut === true) {
      throw new Error(
        `the self-test did not exit within ${timeoutMs} ms${reason}${output}`,
      );
    }

    if (outcome.code !== 0) {
      throw new Error(
        `the self-test exited with code ${outcome.code}${reason}${output}`,
      );
    }

    if (result === undefined) {
      throw new Error(
        `the self-test wrote no result at ${resultPath}${output}`,
      );
    }

    if (result !== 'packaged koffi ok') {
      throw new Error(`the self-test result was "${result}"${output}`);
    }

    return result;
  } finally {
    if (
      child !== undefined &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill();
    }

    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (!existsSync(ASAR_PATH)) {
    fail(
      `packaged release is missing: ${ASAR_PATH}; run \`npm.cmd run dist:dir\` first`,
    );
  }

  let header;

  try {
    const buffer = readFileSync(ASAR_PATH);
    const jsonSize = buffer.readUInt32LE(12);
    header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'));
  } catch (error) {
    fail(`cannot read the asar header at ${ASAR_PATH}: ${error.message}`);
  }

  const modules = header?.files?.node_modules?.files;
  const koromix = modules?.['@koromix']?.files?.['koffi-win32-x64'];

  if (modules?.koffi === undefined) {
    fail(`koffi is missing from ${ASAR_PATH}`);
  }

  if (koromix === undefined) {
    fail(`@koromix/koffi-win32-x64 is missing from ${ASAR_PATH}`);
  }

  if (koromix.unpacked !== true) {
    fail(`@koromix/koffi-win32-x64 is not unpacked in ${ASAR_PATH}`);
  }

  if (!existsSync(NATIVE_PATH)) {
    fail(`the unpacked native module is missing: ${NATIVE_PATH}`);
  }

  if (statSync(NATIVE_PATH).size === 0) {
    fail(`the unpacked native module is empty: ${NATIVE_PATH}`);
  }

  const loaded = { exports: {} };

  try {
    process.dlopen(loaded, NATIVE_PATH);
  } catch (error) {
    fail(`cannot load ${NATIVE_PATH}: ${error.message}`);
  }

  if (
    typeof loaded.exports !== 'object' ||
    loaded.exports === null ||
    Object.keys(loaded.exports).length === 0
  ) {
    fail(`the native module at ${NATIVE_PATH} exported nothing`);
  }

  console.log(`app.asar: ${path.relative(ROOT, ASAR_PATH)}`);
  console.log(`koffi.node: ${path.relative(ROOT, NATIVE_PATH)}`);
  console.log('packaged koffi ok');

  await runSelfTest();
  console.log('packaged koffi ok (electron)');
}

const executedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (executedDirectly) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
