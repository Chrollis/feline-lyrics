import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { c } from 'tar';

import {
  ensurePython,
  parseReleasePage,
  resolvePythonRelease,
  selectPythonAsset,
  ToolchainError,
} from '../../out/index.js';

const TRIPLE = 'x86_64-pc-windows-msvc';
const TAG = '20261124';
const STRIPPED = `cpython-3.12.16+${TAG}-${TRIPLE}-install_only_stripped.tar.gz`;
const FULL = `cpython-3.12.16+${TAG}-${TRIPLE}-install_only.tar.gz`;
const OLDER = `cpython-3.12.15+${TAG}-${TRIPLE}-install_only_stripped.tar.gz`;

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function serve(handler) {
  const server = createServer((request, response) => {
    handler(request, response);
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

function expandedPage(assets) {
  return assets
    .map(
      (asset) =>
        `<li><a href="/astral-sh/python-build-standalone/releases/download/${TAG}/${encodeURIComponent(
          asset.name,
        )}">${asset.name}</a><span>sha256:${asset.sha256}</span></li>`,
    )
    .join('\n');
}

function config(python, release = TAG) {
  return {
    uv: [],
    python,
    packages: [],
    pythonRelease: release,
  };
}

test('selects the newest patch, then the stripped archive', () => {
  const selected = selectPythonAsset([OLDER, FULL, STRIPPED], TRIPLE, '3.12');

  assert.equal(selected.name, STRIPPED);
  assert.equal(selected.version, '3.12.16');
  assert.equal(selected.stripped, true);
});

test('ignores other series and other platforms', () => {
  const other = 'cpython-3.13.0+20261124-x86_64-pc-windows-msvc-install_only_stripped.tar.gz';
  const linux = 'cpython-3.12.16+20261124-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz';

  assert.equal(selectPythonAsset([other, linux], TRIPLE, '3.12'), null);
});

test('pairs release assets with their digests', () => {
  const digest = 'a'.repeat(64);
  const assets = parseReleasePage(expandedPage([{ name: STRIPPED, sha256: digest }]));

  assert.equal(assets.length, 1);
  assert.equal(assets[0].name, STRIPPED);
  assert.equal(assets[0].sha256, digest);
});

test('resolves a pinned tag through the official listing', async () => {
  const digest = 'b'.repeat(64);
  const server = await serve((request, response) => {
    if (request.url === `/expanded_assets/${TAG}`) {
      response.end(expandedPage([{ name: STRIPPED, sha256: digest }]));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const release = await resolvePythonRelease({
      config: config([`${server.url}/releases/download/{tag}/{asset}`]),
    });

    assert.equal(release.tag, TAG);
    assert.equal(release.version, '3.12.16');
    assert.equal(release.asset, STRIPPED);
    assert.equal(release.sha256, digest);
    assert.equal(
      release.url,
      `${server.url}/releases/download/${TAG}/${STRIPPED}`,
    );
  } finally {
    await server.close();
  }
});

test('reads the official listing and downloads through a {url} proxy', async () => {
  const digest = 'e'.repeat(64);
  const server = await serve((request, response) => {
    if (request.url === `/listing/${TAG}`) {
      response.end(expandedPage([{ name: STRIPPED, sha256: digest }]));
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const release = await resolvePythonRelease({
      config: config(['https://proxy.example/{url}']),
      listingBase: `${server.url}/listing`,
      downloadBase: `${server.url}/download`,
    });

    assert.equal(release.tag, TAG);
    assert.equal(release.asset, STRIPPED);
    assert.equal(release.sha256, digest);
    assert.equal(
      release.url,
      `https://proxy.example/${server.url}/download/${TAG}/${STRIPPED}`,
    );
  } finally {
    await server.close();
  }
});

test('resolves latest through the github redirect', async () => {
  const server = await serve((request, response) => {
    if (request.url === '/latest') {
      response.statusCode = 302;
      response.setHeader('location', `/releases/tag/${TAG}`);
      response.end();
      return;
    }
    if (request.url === `/expanded_assets/${TAG}`) {
      response.end(
        expandedPage([{ name: STRIPPED, sha256: 'c'.repeat(64) }]),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const release = await resolvePythonRelease({
      config: config([`${server.url}/releases/download/{tag}/{asset}`], 'latest'),
      latestTagUrl: `${server.url}/latest`,
    });

    assert.equal(release.tag, TAG);
  } finally {
    await server.close();
  }
});

test('falls back to a mirror tag listing when github does not answer', async () => {
  const server = await serve((request, response) => {
    if (request.url === '/latest') {
      response.statusCode = 500;
      response.end();
      return;
    }
    if (request.url === '/mirror/') {
      response.end(`<a href="/mirror/${TAG}/">${TAG}</a>`);
      return;
    }
    if (request.url === `/mirror/${TAG}/`) {
      response.end(`<a href="${FULL}">${FULL}</a>`);
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const release = await resolvePythonRelease({
      config: config([`${server.url}/mirror/{tag}/{asset}`], 'latest'),
      latestTagUrl: `${server.url}/latest`,
    });

    assert.equal(release.version, '3.12.16');
    assert.equal(release.asset, FULL);
    assert.equal(release.sha256, undefined);
  } finally {
    await server.close();
  }
});

test('reports a browser challenge instead of calling it a missing file', async () => {
  const server = await serve((request, response) => {
    if (request.url === '/latest') {
      response.statusCode = 500;
      response.end();
      return;
    }
    response.statusCode = 403;
    response.end('<html><body>Verifying your browser, requires JavaScript</body></html>');
  });

  try {
    await assert.rejects(
      resolvePythonRelease({
        config: config([`${server.url}/mirror/{tag}/{asset}`], 'latest'),
        latestTagUrl: `${server.url}/latest`,
      }),
      (error) =>
        error instanceof ToolchainError &&
        error.code === 'download/browser-required',
    );
  } finally {
    await server.close();
  }
});

async function pythonArchive(root) {
  const source = join(root, 'tree');
  mkdirSync(join(source, 'python'), { recursive: true });
  writeFileSync(join(source, 'python', 'python.exe'), 'not really python');
  // Above the cache floor, so a second call can prove it reused the download.
  writeFileSync(join(source, 'python', 'payload.bin'), randomBytes(2 * 1024 * 1024));
  const archive = join(root, 'python.tar.gz');
  await c({ gzip: true, file: archive, cwd: source }, ['python']);
  return archive;
}

test('downloads, verifies, unpacks and reuses the cached archive', async () => {
  const root = tempDir('felyrics-python-');
  const archive = await pythonArchive(root);
  const bytes = readFileSync(archive);
  const digest = createHash('sha256').update(bytes).digest('hex');
  let downloads = 0;

  const server = await serve((request, response) => {
    if (request.url === `/expanded_assets/${TAG}`) {
      response.end(expandedPage([{ name: STRIPPED, sha256: digest }]));
      return;
    }
    if (request.url === `/releases/download/${TAG}/${STRIPPED}`) {
      downloads += 1;
      response.setHeader('content-type', 'application/gzip');
      response.end(bytes);
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const options = {
      config: config([`${server.url}/releases/download/{tag}/{asset}`]),
      destination: join(root, 'backend', 'python'),
      cacheDir: join(root, 'cache'),
      fetchImpl: fetch,
      verify: async () => {},
    };
    const first = await ensurePython(options);

    assert.equal(first.release.version, '3.12.16');
    assert.ok(existsSync(first.pythonPath));
    assert.equal(first.pythonPath, join(root, 'backend', 'python', 'python', 'python.exe'));

    const second = await ensurePython(options);

    assert.equal(second.pythonPath, first.pythonPath);
    assert.equal(downloads, 1, 'the cached archive is not downloaded twice');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses an archive that does not match the published digest', async () => {
  const root = tempDir('felyrics-python-');
  const archive = await pythonArchive(root);
  const bytes = readFileSync(archive);

  const server = await serve((request, response) => {
    if (request.url === `/expanded_assets/${TAG}`) {
      response.end(expandedPage([{ name: STRIPPED, sha256: 'd'.repeat(64) }]));
      return;
    }
    if (request.url === `/releases/download/${TAG}/${STRIPPED}`) {
      response.end(bytes);
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    await assert.rejects(
      ensurePython({
        config: config([`${server.url}/releases/download/{tag}/{asset}`]),
        destination: join(root, 'backend', 'python'),
        cacheDir: join(root, 'cache'),
        verify: async () => {},
      }),
      (error) =>
        error instanceof ToolchainError &&
        error.code === 'python/checksum-failed',
    );
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
