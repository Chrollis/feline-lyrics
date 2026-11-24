import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  PluginHandle,
  PluginHosts,
  servePlugin,
} from '../dist/index.js';

/** A pair of endpoints that delivers asynchronously, like a real port. */
function createPair() {
  const toHost = new Set();
  const toPlugin = new Set();
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const host = {
    send(message) {
      queueMicrotask(() => {
        for (const listener of toPlugin) {
          listener(message);
        }
      });
    },
    onMessage(listener) {
      toHost.add(listener);
      return () => toHost.delete(listener);
    },
    closed,
    close() {
      resolveClosed();
    },
  };

  const plugin = {
    send(message) {
      queueMicrotask(() => {
        for (const listener of toHost) {
          listener(message);
        }
      });
    },
    onMessage(listener) {
      toPlugin.add(listener);
      return () => toPlugin.delete(listener);
    },
    closed,
    close() {
      resolveClosed();
    },
  };

  return { host, plugin };
}

async function fixture(source) {
  const directory = await mkdtemp(join(tmpdir(), 'felyrics-plugin-'));
  await writeFile(join(directory, 'index.mjs'), source, 'utf8');

  return directory;
}

function manifest(directory, overrides = {}) {
  return {
    id: 'fixtures.echo',
    directory,
    name: 'fixtures.echo',
    version: '1.0.0',
    author: 'tester',
    api: 1,
    host: 'utility',
    main: 'index.mjs',
    methods: ['echo'],
    internal: [],
    commands: [],
    errors: [],
    jobs: [],
    ...overrides,
  };
}

async function start(t, source, overrides = {}, options = {}) {
  const directory = await fixture(source);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const channels = createPair();
  servePlugin(channels.plugin);

  const handle = new PluginHandle(manifest(directory, overrides), {
    createChannel: () => channels.host,
    activationTimeoutMs: 200,
    disposalTimeoutMs: 200,
    ...options,
  });

  return handle;
}

const ECHO = `
export async function activate(ctx) {
  ctx.method('echo', (params) => ({ echo: params.value }));
}
`;

test('enable activates and request reaches the registered method', async (t) => {
  const handle = await start(t, `
export async function activate(ctx) {
  ctx.method('echo', (params) => ({ echo: params.value }));
}
`);

  await handle.enable();

  assert.equal(handle.state, 'ACTIVE');
  assert.deepEqual(handle.publicMethods, ['fixtures.echo/echo']);
  assert.deepEqual(await handle.request('fixtures.echo/echo', { value: 2 }), {
    echo: 2,
  });
});

test('a request without a timeout is not cut by a host clock', async (t) => {
  const handle = await start(
    t,
    `
export async function activate(ctx) {
  ctx.method('slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { waited: true };
  });
}
`,
    { methods: ['slow'] },
  );

  await handle.enable();
  assert.deepEqual(await handle.request('fixtures.echo/slow', {}), {
    waited: true,
  });
});

test('an explicit timeout still stops a slow request', async (t) => {
  const handle = await start(
    t,
    `
export async function activate(ctx) {
  ctx.method('slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {};
  });
}
`,
    { methods: ['slow'] },
  );

  await handle.enable();
  await assert.rejects(handle.request('fixtures.echo/slow', {}, 5), (error) => {
    assert.equal(error.code, 'core/timeout');

    return true;
  });
});

test('a backend call is routed through the host services', async (t) => {
  const calls = [];
  const handle = await start(
    t,
    `
export async function activate(ctx) {
  ctx.method('echo', (params) => ctx.backend.call('echo', params));
}
`,
    { python: { module: 'fixtures', attribute: 'serve' } },
    {
      host: {
        pickFile: async () => null,
        backend: {
          call: async (name, params, options) => {
            calls.push([name, params, options]);

            return { echo: params.value };
          },
        },
      },
    },
  );

  await handle.enable();

  assert.deepEqual(await handle.request('fixtures.echo/echo', { value: 3 }), {
    echo: 3,
  });
  assert.deepEqual(calls, [['fixtures.echo/echo', { value: 3 }, {}]]);
});

test('a plugin with no backend route is refused, not hung', async (t) => {
  const handle = await start(
    t,
    `
export async function activate(ctx) {
  ctx.method('echo', (params) => ctx.backend.call('echo', params));
}
`,
    { python: { module: 'fixtures', attribute: 'serve' } },
  );

  await handle.enable();

  await assert.rejects(
    handle.request('fixtures.echo/echo', { value: 3 }),
    (error) => {
      assert.equal(error.code, 'core/not-ready');

      return true;
    },
  );
});

test('a TS-only plugin has no backend in its context', async (t) => {
  const handle = await start(t, `
export async function activate(ctx) {
  if (ctx.backend !== undefined) {
    throw new Error('a TS-only plugin must not receive a backend');
  }

  ctx.method('echo', () => ({ fine: true }));
}
`);

  await handle.enable();

  assert.deepEqual(await handle.request('fixtures.echo/echo', {}), {
    fine: true,
  });
});

test('a declared method the plugin did not register fails the plugin', async (t) => {
  const handle = await start(t, 'export async function activate() {}');

  await assert.rejects(handle.enable(), (error) => {
    assert.equal(error.code, 'core/methods-mismatch');
    assert.equal(error.issues[0].path, 'contributes.methods');

    return true;
  });
  assert.equal(handle.state, 'FAILED');
});

test('a registered method the manifest did not declare fails the plugin', async (t) => {
  const handle = await start(t, `
export async function activate(ctx) {
  ctx.method('echo', () => ({}));
  ctx.method('extra', () => ({}));
}
`);

  await assert.rejects(handle.enable(), (error) => {
    assert.equal(error.code, 'core/methods-mismatch');
    assert.match(JSON.stringify(error.issues), /extra/);

    return true;
  });
});

test('a command must be declared and registered like a method', async (t) => {
  const handle = await start(
    t,
    `
export async function activate(ctx) {
  ctx.method('echo', () => ({}));
}
`,
    { commands: [{ id: 'hello', title: 'Hello' }] },
  );

  await assert.rejects(handle.enable(), (error) => {
    assert.equal(error.code, 'core/methods-mismatch');
    assert.equal(error.issues[0].path, 'contributes.commands');

    return true;
  });
});

const CHOOSE = `
export async function activate(ctx) {
  ctx.method('echo', () => ({}));
  ctx.command('choose', () => ctx.host.pickFile({ kind: 'audio' }));
}
`;

test('a command runs in the plugin and can ask the host to pick a file', async (t) => {
  const picked = [];

  const handle = await start(
    t,
    CHOOSE,
    { commands: [{ id: 'choose', title: 'Choose' }] },
    {
      host: {
        pickFile: async (options) => {
          picked.push(options.kind);

          return '/tmp/song.flac';
        },
      },
    },
  );

  await handle.enable();

  assert.equal(await handle.command('fixtures.echo/choose'), '/tmp/song.flac');
  assert.deepEqual(picked, ['audio']);
});

test('a cancelled picker answers null, not an error', async (t) => {
  const handle = await start(
    t,
    CHOOSE,
    { commands: [{ id: 'choose', title: 'Choose' }] },
    { host: { pickFile: async () => null } },
  );

  await handle.enable();

  assert.equal(await handle.command('fixtures.echo/choose'), null);
});

test('a command nobody declared is refused before it reaches the plugin', async (t) => {
  const handle = await start(t, ECHO);

  await assert.rejects(
    handle.command('fixtures.echo/choose'),
    (error) => {
      assert.equal(error.code, 'core/not-ready');

      return true;
    },
  );

  await handle.enable();

  await assert.rejects(
    handle.command('fixtures.echo/choose'),
    (error) => {
      assert.equal(error.code, 'protocol/unknown-method');

      return true;
    },
  );
});

test('a host without a picker refuses the call instead of hanging', async (t) => {
  const handle = await start(t, CHOOSE, {
    commands: [{ id: 'choose', title: 'Choose' }],
  });

  await handle.enable();

  await assert.rejects(
    handle.command('fixtures.echo/choose'),
    (error) => {
      assert.equal(error.code, 'core/not-ready');

      return true;
    },
  );
});

test('a picker kind the host does not know is a bad request', async (t) => {
  const handle = await start(
    t,
    `
export async function activate(ctx) {
  ctx.command('choose', () => ctx.host.pickFile({ kind: 'movie' }));
}
`,
    { commands: [{ id: 'choose', title: 'Choose' }], methods: [] },
    { host: { pickFile: async () => '/tmp/never' } },
  );

  await handle.enable();

  await assert.rejects(
    handle.command('fixtures.echo/choose'),
    (error) => {
      assert.equal(error.code, 'protocol/bad-request');

      return true;
    },
  );
});

test('request names are checked before they reach the plugin', async (t) => {
  const handle = await start(t, ECHO);

  await assert.rejects(handle.request('fixtures.echo/echo', {}), (error) => {
    assert.equal(error.code, 'core/not-ready');

    return true;
  });

  await handle.enable();

  await assert.rejects(handle.request('other.plugin/echo', {}), (error) => {
    assert.equal(error.code, 'protocol/unknown-method');

    return true;
  });

  await assert.rejects(handle.request('fixtures.echo/nope', {}), (error) => {
    assert.equal(error.code, 'protocol/unknown-method');

    return true;
  });
});

test('an undeclared plugin code becomes core/internal', async (t) => {
  const handle = await start(t, `
export async function activate(ctx) {
  ctx.method('echo', () => {
    throw { code: 'fixtures.echo/boom', message: 'boom' };
  });
}
`);

  await handle.enable();

  await assert.rejects(handle.request('fixtures.echo/echo', {}), (error) => {
    assert.equal(error.code, 'core/internal');
    assert.equal(error.data.originalCode, 'fixtures.echo/boom');
    assert.match(error.message, /fixtures\.echo\/boom/);

    return true;
  });
});

test('a declared plugin code keeps its name', async (t) => {
  const handle = await start(
    t,
    `
export async function activate(ctx) {
  ctx.method('echo', () => {
    throw { code: 'fixtures.echo/boom', message: 'boom' };
  });
}
`,
    { errors: ['boom'] },
  );

  await handle.enable();

  await assert.rejects(handle.request('fixtures.echo/echo', {}), (error) => {
    assert.equal(error.code, 'fixtures.echo/boom');
    assert.equal(error.message, 'boom');

    return true;
  });
});

test('a code from another plugin becomes core/internal', async (t) => {
  const handle = await start(t, `
export async function activate(ctx) {
  ctx.method('echo', () => {
    throw { code: 'someone.else/boom', message: 'boom' };
  });
}
`);

  await handle.enable();

  await assert.rejects(handle.request('fixtures.echo/echo', {}), (error) => {
    assert.equal(error.code, 'core/internal');
    assert.equal(error.data.originalCode, 'someone.else/boom');

    return true;
  });
});

test('dispose runs newest first and the plugin stops answering', async (t) => {
  process.env.DISPOSE_LOG = join(
    await mkdtemp(join(tmpdir(), 'felyrics-dispose-')),
    'log.txt',
  );

  try {
    const handle = await start(t, `
import { appendFileSync } from 'node:fs';

export async function activate(ctx) {
  ctx.method('echo', () => ({}));
  ctx.onDispose(() => appendFileSync(process.env.DISPOSE_LOG, 'one\\n'));
  ctx.onDispose(() => appendFileSync(process.env.DISPOSE_LOG, 'two\\n'));
}
`);

    await handle.enable();
    await handle.disable();

    assert.equal(handle.state, 'DISPOSED');
    assert.equal(await readFile(process.env.DISPOSE_LOG, 'utf8'), 'two\none\n');
    await assert.rejects(handle.request('fixtures.echo/echo', {}), (error) => {
      assert.equal(error.code, 'core/not-ready');

      return true;
    });
  } finally {
    delete process.env.DISPOSE_LOG;
  }
});

test('an activate that never settles times out and fails', async (t) => {
  const handle = await start(
    t,
    'export async function activate() { return new Promise(() => {}); }',
    {},
  );

  await assert.rejects(handle.enable(), (error) => {
    assert.equal(error.code, 'core/timeout');

    return true;
  });
  assert.equal(handle.state, 'FAILED');
});

test('an activate that throws is refused', async (t) => {
  const handle = await start(
    t,
    "export async function activate() { throw new Error('nope'); }",
  );

  await assert.rejects(handle.enable(), (error) => {
    assert.equal(error.code, 'core/internal');
    assert.match(error.message, /nope/);

    return true;
  });
});

test('a plugin that exits during activation fails instead of hanging', async (t) => {
  const directory = await fixture(
    'export async function activate(ctx) { ctx.method("echo", () => ({})); }',
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  const channels = createPair();
  servePlugin(channels.plugin);

  const handle = new PluginHandle(manifest(directory), {
    createChannel: () => channels.host,
    activationTimeoutMs: 1_000,
  });

  const enabling = handle.enable();
  channels.plugin.close();

  await assert.rejects(enabling, (error) => {
    assert.equal(error.code, 'core/internal');

    return true;
  });
  assert.equal(handle.state, 'FAILED');
});

test('the host table lists plugins and routes by id', async (t) => {
  const directory = await fixture(ECHO);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const channels = createPair();
  servePlugin(channels.plugin);

  const hosts = new PluginHosts([manifest(directory)], {
    createChannel: () => channels.host,
    activationTimeoutMs: 200,
  });

  await hosts.enable('fixtures.echo');
  assert.deepEqual(hosts.list(), [
    {
      id: 'fixtures.echo',
      state: 'ACTIVE',
      methods: ['fixtures.echo/echo'],
      commands: [],
    },
  ]);
  assert.deepEqual(await hosts.request('fixtures.echo/echo', { value: 3 }), {
    echo: 3,
  });

  await hosts.disable('fixtures.echo');
  assert.equal(hosts.handle('fixtures.echo').state, 'DISPOSED');
});
