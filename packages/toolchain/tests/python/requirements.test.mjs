import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  readRequirements,
  REQUIREMENTS_FILENAME,
  requirementModule,
} from '../../out/index.js';

function withServices(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-requirements-'));
  const services = join(root, 'services');

  mkdirSync(services, { recursive: true });

  try {
    return fn(services);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reads one requirement per line', () => {
  withServices((services) => {
    writeFileSync(
      join(services, REQUIREMENTS_FILENAME),
      'av==19.0.2\nnumpy==2.5.5\n',
    );

    assert.deepEqual(readRequirements(services), [
      'av==19.0.2',
      'numpy==2.5.5',
    ]);
  });
});

test('drops comments and blank lines', () => {
  withServices((services) => {
    writeFileSync(
      join(services, REQUIREMENTS_FILENAME),
      '# native dependencies\n\nav==19.0.2\n   \nnumpy\n',
    );

    assert.deepEqual(readRequirements(services), ['av==19.0.2', 'numpy']);
  });
});

test('keeps extras and markers verbatim', () => {
  withServices((services) => {
    const line = 'stable-ts[fw]==2.17.0; python_version < "3.13"';

    writeFileSync(join(services, REQUIREMENTS_FILENAME), `${line}\n`);

    assert.deepEqual(readRequirements(services), [line]);
  });
});

test('reads the import name from a requirement', () => {
  assert.equal(requirementModule('av==19.0.2'), 'av');
  assert.equal(requirementModule('numpy'), 'numpy');
  assert.equal(requirementModule('stable-ts[fw]>=2'), 'stable-ts');
});

test('throws when the services directory has no requirements file', () => {
  withServices((services) => {
    assert.throws(
      () => readRequirements(join(services, 'nope')),
      (error) => error.code === 'ENOENT',
    );
  });
});
