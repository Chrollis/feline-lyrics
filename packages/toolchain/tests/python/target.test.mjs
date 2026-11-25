import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SUPPORTED_TARGETS, TARGETS } from '../../out/index.js';

test('names every uv asset its archive format can unpack', () => {
  for (const [key, target] of Object.entries(TARGETS)) {
    const extension = target.archive === 'zip' ? '.zip' : '.tar.gz';

    assert.equal(
      target.uvFilename.endsWith(extension),
      true,
      `${key} should end with ${extension}, got ${target.uvFilename}`,
    );
  }
});

test('supports only platforms our extractor can unpack', () => {
  for (const key of SUPPORTED_TARGETS) {
    const target = TARGETS[key];

    assert.ok(target, `${key} is missing from TARGETS`);
    assert.equal(target.archive, 'zip');
  }
});
