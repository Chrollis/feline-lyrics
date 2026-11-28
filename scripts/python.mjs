// Thin developer CLI around the toolchain. It owns two things only: the
// repository defaults, and the flag split. Every actual step lives in
// packages/toolchain, so the app can provision with different directories.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Development defaults come from the toolchain's settings module below, so the
// app and this CLI read the same values; only the checkout location is local.

// The host is a native dependency: its backend is not a plugin and never appears
// under a plugin root, so only the checkout can name it.
const hostBackend = join(root, 'packages', 'host', 'backend');
const pluginsRoot = join(root, 'plugins');

// Optional: the checkout's own mirror list. The app keeps its file in userData;
// here the repository root is the one place a developer would look, and the file
// is ignored by git so a local mirror does not travel with the code.
const mirrorsPath = join(root, 'mirrors.json');

/**
 * The plugins a development environment must satisfy. The directory name is the
 * plugin id -- the manifest says the same, and checking that belongs to the
 * loader, not to this shim. Requirements are in the plugin's `backend/` because
 * each plugin owns what it needs.
 */
function pluginSpecs(toolchain) {
  const specs = [];

  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directory = join(pluginsRoot, entry.name);
    const manifestFile = join(directory, 'package.json');

    if (!existsSync(manifestFile)) {
      continue;
    }

    let manifest;

    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    } catch (error) {
      fail(`cannot read ${manifestFile}: ${error.message}`);
    }

    const python = manifest.felyrics?.backend?.python;
    const requirementsFile = join(directory, 'backend', 'requirements.txt');

    specs.push({
      id: entry.name,
      ...(typeof python === 'string' ? { python } : {}),
      requirements: existsSync(requirementsFile)
        ? toolchain.readRequirements(join(directory, 'backend'))
        : [],
    });
  }

  specs.sort((left, right) => left.id.localeCompare(right.id));

  return specs;
}

/**
 * The shared environment: every backend directory the venv imports from, and
 * every requirement the plugins declare. The order is the plugin id order so the
 * marker fingerprint does not change when the filesystem lists differently.
 */
function environment(toolchain) {
  const specs = pluginSpecs(toolchain);
  const backends = specs
    .map((spec) => join(pluginsRoot, spec.id, 'backend'))
    .filter((directory) => existsSync(directory));

  return {
    specs,
    importPaths: [hostBackend, ...backends],
    requirements: [
      ...new Set(specs.flatMap((spec) => spec.requirements)),
    ],
  };
}

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

async function loadPaths(toolchain) {
  const defaults = toolchain.defaultSettings({
    packaged: false,
    userData: root,
    repoRoot: root,
  });
  const file = join(root, 'settings.json');
  let merged;

  try {
    const settings = await toolchain.loadSettings(file);
    merged = { ...defaults, ...settings };
    toolchain.assertWritableRoots(merged, file, root);
  } catch (error) {
    fail(`cannot use ${file}: ${error.code ?? ''} ${error.message}`);
  }

  return {
    cacheDir: merged.cacheDir,
    backendRoot: merged.backendRoot,
    tempDir: merged.tempDir,
  };
}

async function setup(toolchain) {
  const env = environment(toolchain);
  let mirrors;

  try {
    mirrors = await toolchain.loadMirrorConfig(mirrorsPath);
  } catch (error) {
    fail(`cannot use ${mirrorsPath}: ${error.code ?? ''} ${error.message}`);
  }

  // The scratch directory is the caller's: the toolchain never remembers it,
  // so a killed run cannot leave a directory behind that nobody owns.
  const marker = await toolchain.withTempDir('felyrics-', (tempDir) =>
    toolchain.provision({
      paths,
      tempDir,
      requirements: env.requirements,
      importPaths: env.importPaths,
      mirrors,
      onOutput: (chunk, stream) => {
        (stream === 'stdout' ? process.stdout : process.stderr).write(chunk);
      },
    }),
    toolchain.tempRoleRoot(paths.tempDir, 'cli'),
  );

  console.log(`ready: uv ${marker.uv}, python ${marker.python}`);
  console.log(`imports: ${marker.imports.split('\n').join(', ')}`);
}

async function clean(toolchain) {
  const cliRoot = toolchain.tempRoleRoot(paths.tempDir, 'cli');
  let removed;

  try {
    await toolchain.clearTempDir(cliRoot);
    removed = await toolchain.clearLegacyTempEntries(paths.tempDir);
  } catch (error) {
    fail(`cannot clean ${paths.tempDir}: ${error.code ?? ''} ${error.message}`);
  }

  console.log(`cleaned: ${cliRoot}`);
  console.log(`legacy: ${removed.length === 0 ? 'none' : removed.join(', ')}`);
}

async function doctor(toolchain) {
  console.log(`cacheDir: ${paths.cacheDir}`);
  console.log(`backendRoot: ${paths.backendRoot}`);
  console.log(`tempDir: ${paths.tempDir}`);

  const env = environment(toolchain);
  const report = await toolchain.doctor(paths, {
    requirements: env.requirements,
    importPaths: env.importPaths,
    plugins: env.specs,
  });

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
const paths = await loadPaths(toolchain);

if (args[0] === '--setup') {
  await setup(toolchain);
} else if (args[0] === '--doctor') {
  await doctor(toolchain);
} else if (args[0] === '--clean') {
  await clean(toolchain);
} else if (args.length === 0) {
  console.error(
    'usage: npm run python -- --setup | --doctor | --clean | <python arguments...>',
  );
  process.exitCode = 1;
} else {
  runPython(toolchain, args);
}
