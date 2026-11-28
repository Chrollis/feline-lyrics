import { app, BrowserWindow, dialog, ipcMain, net, shell, utilityProcess } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BackendError,
  createUtilityChannel,
  discoverPlugins,
  PluginHosts,
  type DiscoveredPlugin,
  type DiscoveryIssue,
  type PluginManifest,
  type PluginTransport,
} from '@felyrics/host';
import { asResult, parsePluginCall } from './plugin-ipc.js';
import { mergePluginList } from './plugin-list.js';
import {
  UserPluginController,
  readPluginRequirements,
} from './plugin-enable.js';
import {
  clearStaleTempEntries,
  clearTempDir,
  ensureOwnedTempRoot,
  mirrorConfigPath,
  provisionPluginEnvironment,
  tempRoleRoot,
  ToolchainError,
  withTempDir,
  type ReadyMarker,
  type ResolvedMirrorConfig,
} from '@felyrics/toolchain';
import { APP_ENTRY_URL } from './app-assets.js';
import { registerAppScheme, serveAppProtocol } from './app-protocol.js';
import {
  addUserBackend,
  callBackend,
  configureBackends,
  hostPaths,
  hostSettingsPath,
  loadHostPaths,
  pingBackend,
  resolvePaths,
  shutdownBackend,
  stopPluginBackend,
} from './backend.js';
import { restartBuiltinHosts, shutdownHosts } from './plugin-boot.js';
import type { PluginSummary } from '../preload/api.js';
import { describeFailure, runStartup, type StartupStatus } from './startup.js';
import {
  beginStartup,
  settleStartup,
  withDeadline,
  type StartupAttempt,
} from './startup-attempt.js';
import { loadOrCreateMirrorConfig } from './mirror-config.js';
import { installPickedPlugin } from './plugin-install-runtime.js';
import { installPluginDirectory } from './plugin-install.js';
import { createQuitController } from './quit.js';
import { parseSelfTestArgs, runPackagedKoffiSmoke } from './self-test.js';

// A packaged smoke launched by `scripts/check-package.mjs` gets its own
// userData before the single-instance lock, so it cannot focus or join a
// running Felyrics and leaves nothing behind in the real profile.
const selfTest = parseSelfTestArgs(process.argv);

if (selfTest !== null) {
  app.setPath('userData', selfTest.dir);
}

// Before `app.whenReady()`: the scheme registry is frozen at startup.
registerAppScheme();

// One instance owns provisioning; a second launch focuses the window that is
// already showing progress instead of racing a second `uv` run in the same venv.
const locked = app.requestSingleInstanceLock();

if (!locked) {
  app.quit();
}

/** Where the built renderer lives: `out/main/../renderer`. */
const RENDERER_ROOT = join(import.meta.dirname, '../renderer');

/** The plugin host entry, built beside this file as `out/main/utility.js`. */
const UTILITY_ENTRY = join(import.meta.dirname, 'utility.js');

/**
 * The ids a `app://job/<plugin>/<job>/<file>` URL may name. Discovery fills it
 * before the main window opens, so a stale URL cannot address a cache directory
 * whose plugin the app no longer has.
 */
const jobPluginIds = new Set<string>();

/**
 * The protocol's view of the app. `jobsRoot` starts empty because settings are
 * read just before startup and the protocol only serves requests after that.
 */
const appRoots = {
  rendererRoot: RENDERER_ROOT,
  jobsRoot: '',
  pluginIds: jobPluginIds,
};

let pluginHosts: PluginHosts | null = null;
let pluginFailures: readonly DiscoveryIssue[] = [];
let discoveredPlugins: readonly DiscoveredPlugin[] = [];
const builtinIds = new Set<string>();
let startupMirrors: ResolvedMirrorConfig | null = null;
let progressWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let latestStatus: StartupStatus | null = null;
let starting = false;
/**
 * The attempt whose work still owns `tempDir` and `backendRoot`. Retry waits for
 * it instead of clearing scratch another provision is still writing.
 */
let currentAttempt: StartupAttempt<ReadyMarker> | null = null;

function publishStatus(status: StartupStatus): void {
  latestStatus = status;

  if (progressWindow !== null && !progressWindow.isDestroyed()) {
    progressWindow.webContents.send('bootstrap:status', status);
  }
}

/**
 * The startup window exists before any plugin does: it reports provisioning, and
 * the main window is not created until the environment verifies.
 */
function createProgressWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 360,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    title: 'Felyrics',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/bootstrap.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('closed', () => {
    progressWindow = null;
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];

  if (rendererUrl) {
    void win.loadURL(`${rendererUrl}/bootstrap.html`);
  } else {
    void win.loadFile(join(RENDERER_ROOT, 'bootstrap.html'));
  }

  return win;
}

/** A dead proxy must not leave the progress window spinning forever. */
const STARTUP_DEADLINE_MS = 10 * 60_000;

/** How long Retry waits for an aborted attempt before refusing to race it. */
const STARTUP_STOP_WAIT_MS = 5_000;

/** Runs the environment check, then opens the real window once it verifies. */
async function start(force = false): Promise<void> {
  if (starting) {
    return;
  }

  starting = true;

  try {
    // A timed-out attempt keeps running until its abort reaches a boundary. Its
    // scratch and backend root are still in use, so Retry must wait for it to
    // settle before clearing tempDir or starting a second provision.
    const previous = currentAttempt;

    if (previous !== null) {
      const stopped = await settleStartup(previous, STARTUP_STOP_WAIT_MS);

      if (!stopped) {
        publishStatus({
          phase: 'failed',
          code: 'core/timeout',
          title: 'The previous startup attempt is still stopping',
          message:
            'Felyrics is still stopping the previous attempt; retry again in a moment.',
          log: latestStatus?.log ?? [],
        });

        return;
      }

      if (currentAttempt === previous) {
        currentAttempt = null;
      }
    }

    // A retry replaces the host table; stopping the previous hosts first is
    // what keeps the old utility processes from piling up behind the new one.
    await shutdownPlugins();
    // The pool outlives the host table; close it too, or a pool that answered
    // a ping before Retry keeps its Python processes until the app exits.
    await shutdownBackend();

    const host = await loadHostPaths().catch((error: unknown) => {
      const failure = describeFailure(error);

      publishStatus({
        phase: 'failed',
        title: 'The settings file is not usable',
        code: failure.code,
        message: failure.message,
        configPath: hostSettingsPath(),
        log: latestStatus?.log ?? [],
      });
      throw error;
    });

    appRoots.jobsRoot = join(host.cacheDir, 'jobs');
    const appTempDir = tempRoleRoot(host.tempDir, 'app');
    console.log(`[paths] cacheDir: ${host.cacheDir}`);
    console.log(`[paths] tempDir: ${host.tempDir}`);
    console.log(`[paths] appTempDir: ${appTempDir}`);
    console.log(`[paths] backendRoot: ${host.backendRoot}`);
    console.log(`[paths] pluginEnvsRoot: ${host.pluginEnvsRoot}`);
    console.log(`[paths] userPluginsRoot: ${host.userPluginsRoot}`);

    try {
      await ensureOwnedTempRoot(host.tempDir);
      await clearTempDir(appTempDir);

      const stale = await clearStaleTempEntries(host.tempDir);

      if (stale.length > 0) {
        console.log(`[temp] removed stale: ${stale.join(', ')}`);
      }
    } catch (error) {
      if (error instanceof ToolchainError) {
        const failure = describeFailure(error);

        publishStatus({
          phase: 'failed',
          title: 'The temp directory is not usable',
          code: failure.code,
          message: failure.message,
          configPath: hostSettingsPath(),
          log: latestStatus?.log ?? [],
        });
        throw error;
      }

      // A native EPERM/EBUSY here is residue we could not clear; the next
      // operation recreates whatever it needs.
      console.error(`[temp] could not clear ${appTempDir}`, error);
    }

    const userDataDir = app.getPath('userData');
    let mirrors;

    try {
      // Re-read on every attempt: the progress window offers "Open config", and
      // Retry is how the user gets the edited file picked up.
      mirrors = await loadOrCreateMirrorConfig(userDataDir);
    } catch (error) {
      const failure = describeFailure(error);
      publishStatus({
        phase: 'failed',
        title: 'The mirror configuration is not usable',
        code: failure.code,
        message: failure.message,
        configPath: mirrorConfigPath(userDataDir),
        log: latestStatus?.log ?? [],
      });
      throw error;
    }

    startupMirrors = mirrors;

    const attempt = beginStartup((signal) =>
      runStartup({
        paths: resolvePaths(),
        userDataDir,
        tempDir: appTempDir,
        mirrors,
        fetchImpl: net.fetch as unknown as typeof fetch,
        hostBackendRoot: hostPaths().hostBackendRoot,
        builtinPluginsRoot: hostPaths().builtinPluginsRoot,
        ...(force ? { force: true } : {}),
        signal,
        onStatus: publishStatus,
      }),
    );

    currentAttempt = attempt;
    void attempt.settled.then(() => {
      if (currentAttempt === attempt) {
        currentAttempt = null;
      }
    });

    const marker = await withDeadline(
      attempt.work,
      () => attempt.controller.abort(),
      STARTUP_DEADLINE_MS,
    ).catch((error: unknown) => {
      if (latestStatus?.phase !== 'failed') {
        const failure = describeFailure(error);
        publishStatus({
          phase: 'failed',
          title: 'The Python environment is not ready',
          code: failure.code,
          message: failure.message,
          log: latestStatus?.log ?? [],
        });
      }

      throw error;
    });

    try {
      await enableBuiltinPlugins(marker.python);
    } catch (error) {
      // A builtin plugin is part of the product: if it cannot start, the app
      // has nothing to offer, so startup fails at the progress window instead
      // of opening a window with dead buttons.
      const failure = describeFailure(error);
      publishStatus({
        phase: 'failed',
        title: 'A builtin plugin could not start',
        code: failure.code,
        message: failure.message,
        log: latestStatus?.log ?? [],
      });
      throw error;
    }

    // Create the main window before closing the progress window: a gap with no
    // window would fire `window-all-closed` and quit the app mid-startup.
    if (mainWindow === null) {
      createWindow();
    }

    progressWindow?.destroy();
  } catch (error) {
    // runStartup already reported the failure; the window stays open with the
    // Retry/Rebuild actions, so this is only for the terminal.
    console.error('[bootstrap]', error);
  } finally {
    starting = false;
  }
}

/**
 * Discovers the builtin plugins and starts the ones whose TS face runs in a
 * utility process. A `renderer`-host plugin stays `PENDING` until the renderer
 * host exists; discovery has already proved its manifest.
 */
async function enableBuiltinPlugins(pythonVersion: string): Promise<void> {
  const discovery = await discoverPlugins(
    [
      { path: hostPaths().builtinPluginsRoot, kind: 'builtin' },
      { path: hostPaths().userPluginsRoot, kind: 'user' },
    ],
    { pythonVersion },
  );

  pluginFailures = discovery.issues;
  discoveredPlugins = discovery.plugins;
  builtinIds.clear();

  for (const plugin of discovery.plugins) {
    jobPluginIds.add(plugin.manifest.id);

    if (plugin.root === 'builtin') {
      builtinIds.add(plugin.manifest.id);
    }
  }

  for (const issue of discovery.issues) {
    console.error('[plugin]', issue.directory, issue.code, issue.message);
  }

  await configureBackends({
    host: hostPaths(),
    // A builtin plugin without a python half contributes no process to the
    // group; a user plugin gets a process only when its environment exists.
    builtin: discovery.plugins
      .filter(
        (plugin) =>
          plugin.root === 'builtin' && plugin.manifest.python !== undefined,
      )
      .map((plugin) => ({
        id: plugin.manifest.id,
        directory: plugin.manifest.directory,
      })),
    user: discovery.plugins
      .filter((plugin) => plugin.root === 'user')
      .map((plugin) => ({
        id: plugin.manifest.id,
        directory: plugin.manifest.directory,
      })),
  });

  pluginHosts = await restartBuiltinHosts(
    pluginHosts ?? undefined,
    discovery.plugins,
    () =>
      new PluginHosts(
        discovery.plugins.map((plugin) => plugin.manifest),
        {
          createChannel: (manifest): PluginTransport =>
            createUtilityChannel({
              fork: () =>
                utilityProcess.fork(UTILITY_ENTRY, [], {
                  serviceName: manifest.id,
                }),
            }),
          // The plugin never touches a window: the picker is a host service,
          // answered in the main process where the dialog lives.
          host: {
            pickFile: (options) => pickFile(options.kind),
            // One Python process holds every builtin plugin's backend for now,
            // so the host is the only party that can route a call to it.
            backend: {
              call: (name, params, options) =>
                callBackend(
                  name,
                  params as Record<string, unknown>,
                  options?.timeoutMs ?? BACKEND_TIMEOUT_MS,
                ),
            },
          },
        },
      ),
  );
}

/** Hosts plus the directories discovery could not turn into a plugin. */
function listPlugins(): readonly PluginSummary[] {
  return mergePluginList(pluginHosts?.list() ?? [], pluginFailures).map(
    (summary) => ({ ...summary, builtin: builtinIds.has(summary.id) }),
  );
}

/** One public method call, validated before it reaches the lifecycle. */
async function requestPlugin(request: unknown): Promise<unknown> {
  if (pluginHosts === null) {
    throw new BackendError('core/not-ready', 'the plugin hosts are not enabled');
  }

  const { name, params, timeoutMs } = parsePluginCall(request);

  return pluginHosts.request(name, params as Record<string, unknown>, timeoutMs);
}

function pluginIdFromRequest(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;

    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }

  throw new BackendError('protocol/bad-request', 'a plugin id is required');
}

function findUserPlugin(id: string): DiscoveredPlugin {
  const plugin = discoveredPlugins.find(
    (candidate) => candidate.root === 'user' && candidate.manifest.id === id,
  );

  if (plugin === undefined) {
    throw new BackendError('core/not-ready', `no user plugin ${id} is installed`);
  }

  return plugin;
}

function findUserManifest(id: string): PluginManifest {
  return findUserPlugin(id).manifest;
}

/**
 * Installs a plugin package the user picked and makes it visible as PENDING.
 * The runtime still only runs it after an explicit `enabled`.
 */
async function installUserPlugin(): Promise<readonly PluginSummary[]> {
  const picked = await dialog.showOpenDialog({
    title: 'Choose a plugin directory',
    properties: ['openDirectory'],
  });

  if (picked.canceled || picked.filePaths[0] === undefined) {
    return listPlugins();
  }

  return installPickedPlugin(picked.filePaths[0], {
    pluginsRoot: hostPaths().userPluginsRoot,
    install: installPluginDirectory,
    discovered: () => discoveredPlugins,
    addDiscovered: (manifest) => {
      discoveredPlugins = [...discoveredPlugins, { manifest, root: 'user' }];
    },
    jobIds: jobPluginIds,
    hosts: () => pluginHosts,
    addUserBackend,
    list: listPlugins,
  });
}

async function provisionUserPlugin(
  id: string,
  manifest: PluginManifest,
): Promise<void> {
  const hosts = pluginHosts;
  const mirrors = startupMirrors;

  if (hosts === null || mirrors === null) {
    throw new BackendError('core/not-ready', 'the plugin hosts are not enabled');
  }

  const host = hostPaths();
  const backendDirectory = join(manifest.directory, 'backend');

  await withTempDir(
    'plugin-env-',
    (tempDir) =>
      provisionPluginEnvironment({
        paths: resolvePaths(),
        envRoot: host.pluginEnvsRoot,
        id,
        importPaths: [host.hostBackendRoot, backendDirectory],
        requirements: readPluginRequirements(id, backendDirectory),
        tempDir,
        mirrors,
      }),
    tempRoleRoot(host.tempDir, 'app'),
  );
}

const userPlugins = new UserPluginController(findUserManifest, {
  provision: provisionUserPlugin,
  enableHost: async (id) => {
    const hosts = pluginHosts;

    if (hosts === null) {
      throw new BackendError(
        'core/not-ready',
        'the plugin hosts are not enabled',
      );
    }

    await hosts.enable(id);
  },
  disableHost: async (id) => {
    if (pluginHosts !== null) {
      await pluginHosts.disable(id);
    }
  },
  stopBackend: stopPluginBackend,
  list: listPlugins,
});

async function enableUserPlugin(
  request: unknown,
): Promise<readonly PluginSummary[]> {
  return userPlugins.enable(pluginIdFromRequest(request));
}

async function disableUserPlugin(
  request: unknown,
): Promise<readonly PluginSummary[]> {
  return userPlugins.disable(pluginIdFromRequest(request));
}

/**
 * Closes plugin hosts on the way out. The table stays reachable until the
 * stops finish so the quit deadline can force-close a host that is still busy;
 * it is cleared in `finally` even when one of them fails.
 */
async function shutdownPlugins(): Promise<void> {
  const hosts = pluginHosts;

  if (hosts === null) {
    return;
  }

  try {
    await shutdownHosts(hosts);
  } finally {
    if (pluginHosts === hosts) {
      pluginHosts = null;
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = win;
  win.on('closed', () => {
    mainWindow = null;
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // The preload bridge is the renderer's only door to the backend, and a broken
  // path to it fails silently: the page loads, every button throws on
  // `undefined`. Say it once in the log instead of leaving it to the first click.
  win.webContents.on('did-finish-load', () => {
    void win.webContents
      .executeJavaScript('typeof window.felyrics')
      .then((kind: unknown) => {
        if (kind !== 'object') {
          console.error(
            `the preload bridge is missing (window.felyrics is ${String(kind)})`,
          );
        }
      })
      .catch((error: unknown) => {
        console.error('could not inspect the preload bridge', error);
      });
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    // `npm run dev`: Vite serves the page over http://localhost, where the
    // `app://` policy does not apply and HMR works. Everything else loads the
    // built page from our own origin.
    void win.loadURL(rendererUrl);
  } else {
    void win.loadURL(APP_ENTRY_URL);
  }
}

if (locked) {
  app.whenReady().then(async () => {
    if (selfTest !== null) {
      const ok = await runPackagedKoffiSmoke(selfTest.dir);

      app.exit(ok ? 0 : 1);

      return;
    }

    appRoots.jobsRoot = join(hostPaths().cacheDir, 'jobs');

    serveAppProtocol(appRoots);

    progressWindow = createProgressWindow();
    await start();

    app.on('activate', () => {
      if (mainWindow === null && progressWindow === null) {
        createWindow();
      }
    });
  });

  app.on('second-instance', () => {
    const win = mainWindow ?? progressWindow;

    if (win !== null) {
      if (win.isMinimized()) {
        win.restore();
      }

      win.show();
      win.focus();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

const OPEN_FILE_FILTERS = {
  audio: [
    { name: 'Audio', extensions: ['flac', 'mp3', 'wav', 'm4a', 'ogg', 'opus'] },
  ],
  video: [{ name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov'] }],
} as const;

/** The native picker, because the renderer cannot see the filesystem at all. */
async function pickFile(
  kind: 'audio' | 'video' | 'any',
): Promise<string | null> {
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    ...(kind === 'any'
      ? {}
      : {
          filters: OPEN_FILE_FILTERS[kind].map((filter) => ({
            name: filter.name,
            extensions: [...filter.extensions],
          })),
        }),
  };
  const owner = BrowserWindow.getFocusedWindow();
  const result = await (owner
    ? dialog.showOpenDialog(owner, options)
    : dialog.showOpenDialog(options));

  return result.canceled ? null : (result.filePaths[0] ?? null);
}

// A request that never returns is worse than one that fails: the renderer shows
// a spinner forever with nothing to branch on. Probing and decoding audio are
// bounded by a few seconds in practice; a still batch can legitimately take
// minutes on a long video, so the plugin itself raises that call's budget.
const BACKEND_TIMEOUT_MS = 30_000;

ipcMain.handle('ping', () => 'pong');

ipcMain.handle('backend:ping', () => asResult(() => pingBackend()));

ipcMain.handle('plugin:list', () => asResult(async () => listPlugins()));

ipcMain.handle('plugin:request', (_event, request: unknown) =>
  asResult(() => requestPlugin(request)),
);

ipcMain.handle('plugin:enable', (_event, request: unknown) =>
  asResult(() => enableUserPlugin(request)),
);

ipcMain.handle('plugin:disable', (_event, request: unknown) =>
  asResult(() => disableUserPlugin(request)),
);

ipcMain.handle('plugin:folder', () =>
  asResult(async () => {
    const root = hostPaths().userPluginsRoot;

    await mkdir(root, { recursive: true });

    return shell.openPath(root);
  }),
);

ipcMain.handle('plugin:install', () => asResult(() => installUserPlugin()));

// The startup window asks for the latest status after it subscribes, because the
// run may have started before its page finished loading.
ipcMain.on('bootstrap:ready', () => {
  if (latestStatus !== null && progressWindow !== null) {
    progressWindow.webContents.send('bootstrap:status', latestStatus);
  }
});

ipcMain.handle('bootstrap:retry', () => start(false));
ipcMain.handle('bootstrap:rebuild', () => start(true));
ipcMain.handle('bootstrap:quit', () => {
  app.quit();
});
ipcMain.handle('bootstrap:open-log', async () => {
  await shell.openPath(join(app.getPath('userData'), 'logs', 'provision.log'));
});
ipcMain.handle('bootstrap:open-config', async () => {
  const target =
    latestStatus?.configPath ?? mirrorConfigPath(app.getPath('userData'));

  await shell.openPath(target);
});

/**
 * Closing stdin is how the backend learns to stop: its read loop ends on EOF, so
 * the process exits on its own instead of being killed mid-write.
 *
 * The controller holds the first quit for at most five seconds while both halves
 * close; a second quit skips the wait, and the deadline force-closes the
 * utility children before exiting.
 */
const quitController = createQuitController({
  shutdownPlugins,
  shutdownBackend,
  forceClosePlugins: () => pluginHosts?.forceClose(),
  quit: () => app.quit(),
  exit: (code) => app.exit(code),
  log: (message, error) => {
    console.error(message, error);
  },
});

app.on('before-quit', (event) => {
  quitController.beforeQuit(event);
});
