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

test('writes one absolute line per import directory', () => {
  withRoot((toolchain, backend) => {
    const host = join(toolchain.servicesDir, 'host');
    const plugin = join(toolchain.servicesDir, 'plugin');
    const file = writePth(backend, [host, plugin]);

    assert.equal(file, join(backend.sitePackages, PTH_FILENAME));
    assert.equal(
      readFileSync(file, 'utf8'),
      `${resolve(host)}\n${resolve(plugin)}\n`,
    );
  });
});

test('creates site-packages when the venv has none yet', () => {
  withRoot((toolchain, backend) => {
    assert.equal(existsSync(backend.sitePackages), false);

    writePth(backend, [toolchain.servicesDir]);

    assert.equal(existsSync(backend.sitePackages), true);
  });
});

test('resolves a relative import directory', () => {
  withRoot((_toolchain, backend) => {
    writePth(backend, ['services', 'plugins/media/backend']);

    assert.equal(
      readFileSync(join(backend.sitePackages, PTH_FILENAME), 'utf8'),
      `${resolve('services')}\n${resolve('plugins/media/backend')}\n`,
    );
  });
});
