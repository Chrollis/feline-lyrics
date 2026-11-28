// Smoke the packaged app: koffi's JS package must be inside app.asar and its
// native module must be unpacked and loadable. Run after `npm run dist:dir`.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function fail(message) {
  console.error(message);
  process.exit(1);
}

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
