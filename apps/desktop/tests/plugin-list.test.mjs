import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergePluginList } from '../src/main/plugin-list.ts';

const media = {
  id: 'felyrics.media',
  state: 'ACTIVE',
  methods: ['felyrics.media/probe'],
  commands: [],
};

test('a failure with a free id is listed under that id', () => {
  const list = mergePluginList([media], [
    {
      directory: 'C:/plugins/someone.broken',
      root: 'user',
      code: 'core/manifest-invalid',
      message: 'the manifest has 1 problem(s)',
    },
  ]);

  assert.deepEqual(
    list.map((plugin) => [plugin.id, plugin.state]),
    [
      ['felyrics.media', 'ACTIVE'],
      ['someone.broken', 'FAILED'],
    ],
  );
  assert.equal(list[1].message, 'core/manifest-invalid: the manifest has 1 problem(s)');
});

test('a user copy of a builtin id stays visible under a rooted id', () => {
  const list = mergePluginList([media], [
    {
      directory: 'C:/user/plugins/felyrics.media',
      root: 'user',
      code: 'core/duplicate-id',
      message: 'felyrics.media is already loaded from C:/builtin/felyrics.media',
    },
  ]);

  assert.deepEqual(
    list.map((plugin) => [plugin.id, plugin.state]),
    [
      ['felyrics.media', 'ACTIVE'],
      ['user:felyrics.media', 'FAILED'],
    ],
  );
  assert.equal(list[1].methods.length, 0);
});

test('two failures with the same directory name both survive', () => {
  const list = mergePluginList([], [
    {
      directory: 'C:/a/same.name',
      root: 'builtin',
      code: 'core/manifest-invalid',
      message: 'broken',
    },
    {
      directory: 'C:/b/same.name',
      root: 'user',
      code: 'core/duplicate-id',
      message: 'already loaded',
    },
  ]);

  assert.deepEqual(
    list.map((plugin) => plugin.id),
    ['same.name', 'user:same.name'],
  );
});

test('no failures means a copy of the hosts', () => {
  const list = mergePluginList([media], []);

  assert.deepEqual(list, [media]);
});
