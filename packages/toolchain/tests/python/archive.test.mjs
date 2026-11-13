import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  UnusableArchiveError,
  extract,
  findTar,
  listArchive,
} from '../../out/index.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'felyrics-archive-'));

  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function catchError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to throw');
}

function fakeTar({
  entries = [],
  status = 0,
  extractStatus = 0,
  stdout,
  stderr = '',
} = {}) {
  const calls = [];

  const spawn = (command, args) => {
    calls.push([command, ...args]);

    if (args[0] === '-tf') {
      return {
        status,
        stdout: stdout ?? entries.map((entry) => `${entry}\n`).join(''),
        stderr,
      };
    }

    return { status: extractStatus, stdout: '', stderr };
  };

  return { spawn, calls };
}

function extractions(calls) {
  return calls.filter((call) => call[1] === '-xf');
}

test('lists one entry per line', () => {
  const { spawn, calls } = fakeTar({
    stdout: 'python/\r\npython/python.exe\r\n',
  });

  assert.deepEqual(listArchive('tar', 'runtime.tar.gz', spawn), [
    'python/',
    'python/python.exe',
  ]);
  assert.deepEqual(calls, [['tar', '-tf', 'runtime.tar.gz']]);
});

test('reports a listing tar could not produce', () => {
  const { spawn } = fakeTar({ status: 2, stderr: 'tar: could not open\n' });

  const error = catchError(() => listArchive('tar', 'missing.tar.gz', spawn));

  assert.ok(error instanceof UnusableArchiveError);
  assert.match(
    error.message,
    /tar -tf could not list the archive \(exit 2\): tar: could not open/,
  );
});

test('surfaces a failed spawn instead of a listing', () => {
  const spawn = () => ({
    status: null,
    stdout: '',
    stderr: '',
    error: new Error('spawn tar ENOENT'),
  });

  const error = catchError(() => listArchive('tar', 'x.tar.gz', spawn));

  assert.match(error.message, /spawn tar ENOENT/);
  assert.ok(!(error instanceof UnusableArchiveError));
});

test('surfaces a killed tar instead of a listing', () => {
  const spawn = () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' });

  const error = catchError(() => listArchive('tar', 'x.tar.gz', spawn));

  assert.match(error.message, /killed by SIGKILL/);
  assert.ok(!(error instanceof UnusableArchiveError));
});

test('lists every entry before extracting', () => {
  withTempDir((dir) => {
    const dest = join(dir, 'out');
    const { spawn, calls } = fakeTar({
      entries: ['python/', 'python/python.exe'],
    });

    const entries = extract('tar', 'runtime.tar.gz', dest, spawn);

    assert.deepEqual(entries, ['python/', 'python/python.exe']);
    assert.deepEqual(calls, [
      ['tar', '-tf', 'runtime.tar.gz'],
      ['tar', '-xf', 'runtime.tar.gz', '-C', dest],
    ]);
    assert.ok(existsSync(dest));
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
  test(`refuses an archive containing ${JSON.stringify(entry)}`, () => {
    withTempDir((dir) => {
      const dest = join(dir, 'out');
      const { spawn, calls } = fakeTar({ entries: ['python/', entry] });

      const error = catchError(() =>
        extract('tar', 'runtime.tar.gz', dest, spawn),
      );

      assert.ok(error instanceof UnusableArchiveError);
      assert.match(error.message, pattern);
      assert.deepEqual(extractions(calls), []);
      assert.equal(existsSync(dest), false);
    });
  });
}

test('allows a name that only contains dots', () => {
  withTempDir((dir) => {
    const { spawn } = fakeTar({ entries: ['python/..hidden', 'a..b'] });

    extract('tar', 'runtime.tar.gz', join(dir, 'out'), spawn);
  });
});

test('reports an unusable archive when tar cannot extract it', () => {
  withTempDir((dir) => {
    const dest = join(dir, 'out');
    const { spawn } = fakeTar({
      entries: ['python/python.exe'],
      extractStatus: 2,
      stderr: 'tar: write error',
    });

    const error = catchError(() =>
      extract('tar', 'runtime.tar.gz', dest, spawn),
    );

    assert.ok(error instanceof UnusableArchiveError);
    assert.match(
      error.message,
      /tar -xf could not extract the archive \(exit 2\): tar: write error/,
    );
    assert.ok(existsSync(dest));
  });
});

test('round-trips a real archive', (t) => {
  const tar = findTar();

  if (tar === null) {
    t.skip('no tar executable on this machine');
    return;
  }

  withTempDir((dir) => {
    const src = join(dir, 'src');
    const dest = join(dir, 'out');
    const archive = join(dir, 'sample.tar.gz');

    mkdirSync(join(src, 'py'), { recursive: true });
    writeFileSync(join(src, 'py', 'hello.txt'), 'hello from tar\n', 'utf8');

    execFileSync(tar, ['-czf', archive, '-C', src, '.']);

    assert.equal(existsSync(dest), false);

    const entries = extract(tar, archive, dest);

    assert.ok(entries.some((entry) => entry.endsWith('py/hello.txt')));
    assert.equal(
      readFileSync(join(dest, 'py', 'hello.txt'), 'utf8'),
      'hello from tar\n',
    );
  });
});
