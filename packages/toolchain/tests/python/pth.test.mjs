import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { backendPaths, PTH_FILENAME, writePth } from '../../out/index.js';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-pth-'));
  const toolchain = {
    cacheDir: join(root, 'cache'),
    servicesDir: join(root, 'services'),
    backendRoot: join(root, 'backend'),
  };

  try {
    return fn(toolchain, backendPaths(toolchain.backendRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('writes the services directory as one absolute line', () => {
  withRoot((toolchain, backend) => {
    const file = writePth(toolchain, backend);

    assert.equal(file, join(backend.sitePackages, PTH_FILENAME));
    assert.equal(
      readFileSync(file, 'utf8'),
      `${resolve(toolchain.servicesDir)}\n`,
    );
  });
});

test('creates site-packages when the venv has none yet', () => {
  withRoot((toolchain, backend) => {
    assert.equal(existsSync(backend.sitePackages), false);

    writePth(toolchain, backend);

    assert.equal(existsSync(backend.sitePackages), true);
  });
});

test('resolves a relative services directory', () => {
  withRoot((toolchain, backend) => {
    const relative = { ...toolchain, servicesDir: 'services' };

    writePth(relative, backend);

    assert.equal(
      readFileSync(join(backend.sitePackages, PTH_FILENAME), 'utf8'),
      `${resolve('services')}\n`,
    );
  });
});
