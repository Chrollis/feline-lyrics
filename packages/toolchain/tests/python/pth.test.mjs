import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { backendPaths, PTH_FILENAME, writePth } from '../../out/index.js';

function withBackend(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-pth-'));
  const backend = backendPaths(join(root, 'backend'));

  try {
    return fn(backend, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('writes one absolute line per import directory', () => {
  withBackend((backend, root) => {
    const host = join(root, 'packages', 'host', 'backend');
    const plugin = join(root, 'plugins', 'felyrics.media', 'backend');
    const file = writePth(backend, [host, plugin]);

    assert.equal(file, join(backend.sitePackages, PTH_FILENAME));
    assert.equal(
      readFileSync(file, 'utf8'),
      `${resolve(host)}\n${resolve(plugin)}\n`,
    );
  });
});

test('creates site-packages when the venv has none yet', () => {
  withBackend((backend, root) => {
    assert.equal(existsSync(backend.sitePackages), false);

    writePth(backend, [join(root, 'packages', 'host', 'backend')]);

    assert.equal(existsSync(backend.sitePackages), true);
  });
});

test('resolves a relative import directory', () => {
  withBackend((backend) => {
    writePth(backend, ['packages/host/backend', 'plugins/felyrics.media/backend']);

    assert.equal(
      readFileSync(join(backend.sitePackages, PTH_FILENAME), 'utf8'),
      `${resolve('packages/host/backend')}\n${resolve('plugins/felyrics.media/backend')}\n`,
    );
  });
});
