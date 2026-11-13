import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ToolchainError, extractZip, listEntries } from '../../out/index.js';

// Built with Compress-Archive on Windows: nested\inner.txt keeps a backslash,
// which is the shape a Windows-made zip has in the wild.
const SAMPLE_ZIP_BASE64 =
  'UEsDBBQAAAAIAM60bV2MTQLQCAAAAAYAAAAQAAAAbmVzdGVkXGlubmVyLnR4dMvMy0st4gIAUEsDBBQAAAAIAM60bV01CU0iEQAAAA8AAAAJAAAAaGVsbG8udHh0y0jNyclXSCvKz1WoyizgAgBQSwECFAAUAAAACADOtG1djE0C0AgAAAAGAAAAEAAAAAAAAAAAAAAAAAAAAAAAbmVzdGVkXGlubmVyLnR4dFBLAQIUABQAAAAIAM60bV01CU0iEQAAAA8AAAAJAAAAAAAAAAAAAAAAADYAAABoZWxsby50eHRQSwUGAAAAAAIAAgB1AAAAbgAAAAAA';

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'felyrics-zip-'));

  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * An in-memory archive: the tests care about which names are refused and where
 * the accepted ones land, not about the bytes of a real file.
 */
function fakeZip({ entries = [], error, readError } = {}) {
  const calls = [];

  const open = async () => ({
    async entries() {
      if (error) {
        throw error;
      }

      return entries.map((entry) =>
        typeof entry === 'string'
          ? { name: entry, isDirectory: entry.endsWith('/') }
          : entry,
      );
    },

    async read(entry, destFile) {
      calls.push(['read', entry.name, destFile]);

      if (readError) {
        throw readError;
      }

      writeFileSync(destFile, `content of ${entry.name}`);
    },

    async close() {
      calls.push(['close']);
    },
  });

  return { open, calls };
}

function reads(calls) {
  return calls.filter((call) => call[0] === 'read');
}

function isToolchainError(error, code) {
  return error instanceof ToolchainError && error.code === code;
}

test('lists entry names without writing anything', async () => {
  const { open, calls } = fakeZip({
    entries: ['python/', 'python/python.exe'],
  });

  assert.deepEqual(await listEntries('uv.zip', open), [
    'python/',
    'python/python.exe',
  ]);
  assert.deepEqual(calls, [['close']]);
});

test('lists every entry before extracting', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'out');
    const { open, calls } = fakeZip({
      entries: ['python/', 'python/python.exe'],
    });

    const names = await extractZip('uv.zip', dest, open);

    assert.deepEqual(names, ['python/', 'python/python.exe']);
    assert.deepEqual(reads(calls), [
      ['read', 'python/python.exe', join(dest, 'python', 'python.exe')],
    ]);
    assert.equal(existsSync(join(dest, 'python')), true);
  });
});

test('turns a backslash in an entry name into a directory', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'out');
    const { open, calls } = fakeZip({
      entries: [{ name: 'nested\\inner.txt', isDirectory: false }],
    });

    await extractZip('uv.zip', dest, open);

    assert.deepEqual(reads(calls), [
      ['read', 'nested\\inner.txt', join(dest, 'nested', 'inner.txt')],
    ]);
  });
});

const UNSAFE_ENTRIES = [
  ['../evil.txt', /parent-directory traversal/],
  ['python/../../evil.txt', /parent-directory traversal/],
  ['..', /parent-directory traversal/],
  ['..\\evil.txt', /parent-directory traversal/],
  ['/etc/passwd', /absolute path/],
  ['C:\\Windows\\System32\\cmd.exe', /drive-letter path/],
  ['C:/Windows/System32/cmd.exe', /drive-letter path/],
];

for (const [entry, pattern] of UNSAFE_ENTRIES) {
  test(`refuses an archive containing ${JSON.stringify(entry)}`, async () => {
    await withTempDir(async (dir) => {
      const dest = join(dir, 'out');
      const { open, calls } = fakeZip({ entries: ['python/', entry] });

      await assert.rejects(extractZip('uv.zip', dest, open), (error) => {
        assert.ok(isToolchainError(error, 'archive/unsafe-entry'));
        assert.equal(error.context.archive, 'uv.zip');
        assert.equal(error.context.entry, entry);
        assert.match(error.message, pattern);
        return true;
      });

      assert.deepEqual(reads(calls), []);
      assert.equal(existsSync(dest), false);
    });
  });
}

test('allows a name that only contains dots', async () => {
  await withTempDir(async (dir) => {
    const dest = join(dir, 'out');
    const { open } = fakeZip({ entries: ['python/..hidden', 'a..b'] });

    await extractZip('uv.zip', dest, open);

    assert.equal(existsSync(join(dest, 'python', '..hidden')), true);
    assert.equal(existsSync(join(dest, 'a..b')), true);
  });
});

test('reports an archive the library cannot read', async () => {
  const { open } = fakeZip({ error: new Error('bad central directory') });

  await assert.rejects(listEntries('broken.zip', open), (error) => {
    assert.ok(isToolchainError(error, 'archive/unusable'));
    assert.equal(error.context.archive, 'broken.zip');
    assert.match(error.message, /bad central directory/);
    return true;
  });
});

test('lets a file system error through unchanged', async () => {
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });

  await withTempDir(async (dir) => {
    const { open } = fakeZip({
      entries: ['uv.exe'],
      readError: denied,
    });

    await assert.rejects(
      extractZip('uv.zip', join(dir, 'out'), open),
      (error) => {
        assert.equal(error, denied);
        assert.ok(!(error instanceof ToolchainError));
        return true;
      },
    );
  });
});

test('extracts a real zip, including a backslash entry', async () => {
  await withTempDir(async (dir) => {
    const archive = join(dir, 'sample.zip');
    const dest = join(dir, 'out');

    writeFileSync(archive, Buffer.from(SAMPLE_ZIP_BASE64, 'base64'));

    const names = await extractZip(archive, dest);

    assert.deepEqual(names.sort(), ['hello.txt', 'nested\\inner.txt']);
    assert.equal(
      readFileSync(join(dest, 'hello.txt'), 'utf8'),
      'hello from zip\n',
    );
    assert.equal(
      readFileSync(join(dest, 'nested', 'inner.txt'), 'utf8'),
      'inner\n',
    );
  });
});
