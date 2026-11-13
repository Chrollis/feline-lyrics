import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SUPPORTED_TARGETS,
  TARGETS,
  UV_DOWNLOAD_BASE,
  UV_VERSION,
  uvDownloadUrl,
} from '../../out/index.js';

test('builds the uv download URL from the mirrored release', () => {
  assert.equal(
    uvDownloadUrl('uv-x86_64-pc-windows-msvc.zip'),
    `${UV_DOWNLOAD_BASE}/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
  );
});

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
