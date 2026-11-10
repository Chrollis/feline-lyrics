import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PACKAGE_NAME } from '../out/index.js';

test('the package exposes its name', () => {
  assert.equal(PACKAGE_NAME, '@felyrics/python-runtime');
});
