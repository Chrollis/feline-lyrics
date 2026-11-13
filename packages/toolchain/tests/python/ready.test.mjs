import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  backendPaths,
  isReady,
  markerMatches,
  readReadyMarker,
  writeReadyMarker,
} from '../../out/index.js';

const MARKER = {
  uv: '0.13.8',
  python: '3.12.15',
  services: 'C:\\app\\services',
};

async function withBackend(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'felyrics-ready-'));

  try {
    const paths = backendPaths(dir);

    mkdirSync(join(dir, 'uv'), { recursive: true });
    mkdirSync(join(dir, 'venv', 'Scripts'), { recursive: true });
    writeFileSync(join(dir, 'uv', 'uv.exe'), '');
    writeFileSync(join(dir, 'venv', 'Scripts', 'python.exe'), '');

    await fn(paths, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('round-trips the marker', async () => {
  await withBackend(async (paths) => {
    await writeReadyMarker(paths, MARKER);

    assert.deepEqual(await readReadyMarker(paths), MARKER);
    assert.equal(await isReady(paths, MARKER), true);
  });
});

test('treats a missing marker as not ready', async () => {
  await withBackend(async (paths) => {
    assert.equal(await readReadyMarker(paths), null);
    assert.equal(await isReady(paths, MARKER), false);
  });
});

test('treats a corrupt marker as not ready', async () => {
  await withBackend(async (paths) => {
    writeFileSync(paths.readyMarker, '{"uv":');

    assert.equal(await readReadyMarker(paths), null);
    assert.equal(await isReady(paths, MARKER), false);
  });
});

test('rejects a different uv version', async () => {
  await withBackend(async (paths) => {
    await writeReadyMarker(paths, { ...MARKER, uv: '0.13.7' });

    assert.equal(await isReady(paths, MARKER), false);
  });
});

test('rejects a different services directory', async () => {
  await withBackend(async (paths) => {
    await writeReadyMarker(paths, {
      ...MARKER,
      services: 'D:\\other\\services',
    });

    assert.equal(await isReady(paths, MARKER), false);
    assert.equal(
      markerMatches({ ...MARKER, services: 'D:\\other\\services' }, MARKER),
      false,
    );
  });
});

test('rejects a backend whose venv was deleted', async () => {
  await withBackend(async (paths, dir) => {
    await writeReadyMarker(paths, MARKER);

    rmSync(join(dir, 'venv', 'Scripts', 'python.exe'), { force: true });

    assert.equal(await isReady(paths, MARKER), false);
  });
});

test('ignores fields a newer version might add', async () => {
  await withBackend(async (paths) => {
    writeFileSync(paths.readyMarker, JSON.stringify({ ...MARKER, extra: 1 }));

    assert.equal(await isReady(paths, MARKER), true);
  });
});
