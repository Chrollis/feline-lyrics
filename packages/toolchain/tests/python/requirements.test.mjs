import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  readRequirements,
  REQUIREMENTS_FILENAME,
  requirementName,
} from '../../out/index.js';

function withRequirements(fn) {
  const root = mkdtempSync(join(tmpdir(), 'felyrics-requirements-'));
  const directory = join(root, 'backend');

  mkdirSync(directory, { recursive: true });

  try {
    return fn(directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('reads one requirement per line', () => {
  withRequirements((directory) => {
    writeFileSync(
      join(directory, REQUIREMENTS_FILENAME),
      'av==19.0.2\nnumpy==2.5.5\n',
    );

    assert.deepEqual(readRequirements(directory), [
      'av==19.0.2',
      'numpy==2.5.5',
    ]);
  });
});

test('drops comments and blank lines', () => {
  withRequirements((directory) => {
    writeFileSync(
      join(directory, REQUIREMENTS_FILENAME),
      '# native dependencies\n\nav==19.0.2\n   \nnumpy\n',
    );

    assert.deepEqual(readRequirements(directory), ['av==19.0.2', 'numpy']);
  });
});

test('keeps extras and markers verbatim', () => {
  withRequirements((directory) => {
    const line = 'stable-ts[fw]==2.17.0; python_version < "3.13"';

    writeFileSync(join(directory, REQUIREMENTS_FILENAME), `${line}\n`);

    assert.deepEqual(readRequirements(directory), [line]);
  });
});

test('reads the distribution name from a requirement', () => {
  assert.equal(requirementName('av==19.0.2'), 'av');
  assert.equal(requirementName('numpy'), 'numpy');
  assert.equal(requirementName('stable-ts[fw]>=2'), 'stable-ts');
  assert.equal(requirementName('Stable_TS.name'), 'stable-ts-name');
});

test('skips a requirement that names no single distribution', () => {
  assert.equal(requirementName('-e .'), '');
  assert.equal(requirementName('-r other.txt'), '');
  assert.equal(requirementName('pkg @ https://example.com/pkg.whl'), '');
});

test('throws when the directory has no requirements file', () => {
  withRequirements((directory) => {
    assert.throws(
      () => readRequirements(join(directory, 'nope')),
      (error) => error.code === 'ENOENT',
    );
  });
});
