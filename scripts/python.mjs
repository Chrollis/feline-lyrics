// Thin developer CLI around the toolchain. It owns two things only: the
// repository defaults, and the flag split. Every actual step lives in
// packages/toolchain, so the app can provision with different directories.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Development defaults: the checkout is the caller, so everything lives inside
// it. The app supplies its own paths (userData for the cache, a chosen
// directory for the backend) and never reaches this file.
const paths = {
  cacheDir: join(root, 'cache'),
  servicesDir: join(root, 'services'),
  backendRoot: join(root, 'python'),
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function loadToolchain() {
  try {
    return await import('../packages/toolchain/out/index.js');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') {
      throw error;
    }

    fail(
      'the toolchain is not built; run: npm run build -w @felyrics/toolchain',
    );
  }
}

async function setup(toolchain) {
  // The scratch directory is the caller's: the toolchain never remembers it,
  // so a killed run cannot leave a directory behind that nobody owns.
  const marker = await toolchain.withTempDir('felyrics-', (tempDir) =>
    toolchain.provision({
      paths,
      tempDir,
      requirements: toolchain.readRequirements(paths.servicesDir),
      onOutput: (chunk, stream) => {
        (stream === 'stdout' ? process.stdout : process.stderr).write(chunk);
      },
    }),
  );

  console.log(`ready: uv ${marker.uv}, python ${marker.python}`);
  console.log(`services: ${marker.services}`);
}

async function doctor(toolchain) {
  const report = await toolchain.doctor(paths);

  for (const check of report.checks) {
    console.log(
      `${check.ok ? 'ok  ' : 'fail'}  ${check.label}: ${check.detail}`,
    );
  }

  process.exitCode = report.ok ? 0 : 1;
}

function runPython(toolchain, args) {
  const backend = toolchain.backendPaths(paths.backendRoot);

  if (!existsSync(backend.venvPython)) {
    fail(
      `no interpreter at ${backend.venvPython}; run: npm run python -- --setup`,
    );
  }

  // The user is talking to Python, so hand it the terminal: no buffering, no
  // captured output, and the exit code is the one to propagate.
  const result = spawnSync(backend.venvPython, args, { stdio: 'inherit' });

  process.exitCode = result.status ?? 1;
}

const args = process.argv.slice(2);
const toolchain = await loadToolchain();

if (args[0] === '--setup') {
  await setup(toolchain);
} else if (args[0] === '--doctor') {
  await doctor(toolchain);
} else if (args.length === 0) {
  console.error(
    'usage: npm run python -- --setup | --doctor | <python arguments...>',
  );
  process.exitCode = 1;
} else {
  runPython(toolchain, args);
}
