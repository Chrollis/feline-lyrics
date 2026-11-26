import { app, BrowserWindow, dialog, ipcMain, net, shell, utilityProcess } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BackendError,
  createUtilityChannel,
  discoverPlugins,
  PluginHosts,
  type DiscoveredPlugin,
  type DiscoveryIssue,
  type PluginTransport,
} from '@felyrics/host';
import { asResult, parsePluginCall } from './plugin-ipc.js';
import { mergePluginList } from './plugin-list.js';
import {
  planUserEnable,
  readPluginRequirements,
} from './plugin-enable.js';
import {
  mirrorConfigPath,
  provisionPluginEnvironment,
  type ResolvedMirrorConfig,
} from '@felyrics/toolchain';
import { APP_ENTRY_URL } from './app-assets.js';
import { registerAppScheme, serveAppProtocol } from './app-protocol.js';
import {
  callBackend,
  configureBackends,
  pingBackend,
  hostPaths,
  resolvePaths,
  shutdownBackend,
  stopPluginBackend,
} from './backend.js';
import { restartBuiltinHosts, shutdownHosts } from './plugin-boot.js';
import type { PluginSummary } from '../preload/api.js';
import { describeFailure, runStartup, type StartupStatus } from './startup.js';
import { loadOrCreateMirrorConfig } from './mirror-config.js';

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

/** The backend's job directories, exactly as it was told at launch. */
const JOBS_ROOT = join(resolvePaths().cacheDir, 'jobs');

/**
 * The ids a `app://job/<plugin>/<job>/<file>` URL may name. Discovery fills it
 * before the main window opens, so a stale URL cannot address a cache directory
 * whose plugin the app no longer has.
 */
const jobPluginIds = new Set<string>();

let pluginHosts: PluginHosts | null = null;
let pluginFailures: readonly DiscoveryIssue[] = [];
let discoveredPlugins: readonly DiscoveredPlugin[] = [];
let startupMirrors: ResolvedMirrorConfig | null = null;
let progressWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let latestStatus: StartupStatus | null = null;
let starting = false;

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

function withDeadline<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BackendError('core/timeout', 'the startup did not finish'));
    }, STARTUP_DEADLINE_MS);

    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Runs the environment check, then opens the real window once it verifies. */
async function start(force = false): Promise<void> {
  if (starting) {
    return;
  }

  starting = true;

  try {
    // A retry replaces the host table; stopping the previous hosts first is
    // what keeps the old utility processes from piling up behind the new one.
    await shutdownPlugins();
    // The pool outlives the host table; close it too, or a pool that answered
    // a ping before Retry keeps its Python processes until the app exits.
    await shutdownBackend();

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
        log: latestStatus?.log ?? [],
      });
      throw error;
    }

    startupMirrors = mirrors;

    const marker = await withDeadline(
      runStartup({
        paths: resolvePaths(),
        userDataDir,
        mirrors,
        fetchImpl: net.fetch as unknown as typeof fetch,
        hostBackendRoot: hostPaths().hostBackendRoot,
        builtinPluginsRoot: hostPaths().builtinPluginsRoot,
        ...(force ? { force: true } : {}),
        onStatus: publishStatus,
      }),
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

  for (const plugin of discovery.plugins) {
    jobPluginIds.add(plugin.manifest.id);
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
  return mergePluginList(pluginHosts?.list() ?? [], pluginFailures);
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

/**
 * Enabling a user plugin is two operations with one failure story: build its
 * environment first (so a missing dependency is reported before any plugin code
 * runs), then let the host table activate it. The backend process starts on the
 * first method call, so an enabled plugin with no traffic costs no process.
 */
async function enableUserPlugin(
  request: unknown,
): Promise<readonly PluginSummary[]> {
  const id = pluginIdFromRequest(request);
  const plugin = findUserPlugin(id);
  const hosts = pluginHosts;
  const mirrors = startupMirrors;

  if (hosts === null || mirrors === null) {
    throw new BackendError('core/not-ready', 'the plugin hosts are not enabled');
  }

  const host = hostPaths();
  const plan = planUserEnable(plugin.manifest);

  if (plan.provision) {
    const backendDirectory = join(plugin.manifest.directory, 'backend');
    const tempDir = await mkdtemp(join(app.getPath('userData'), 'plugin-env-'));
    try {
      await provisionPluginEnvironment({
        paths: resolvePaths(),
        envRoot: host.pluginEnvsRoot,
        id,
        importPaths: [host.hostBackendRoot, backendDirectory],
        requirements: readPluginRequirements(id, backendDirectory),
        tempDir,
        mirrors,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  await hosts.enable(id);

  return listPlugins();
}

/** Disable first, then close the process: a closed process cannot answer. */
async function disableUserPlugin(
  request: unknown,
): Promise<readonly PluginSummary[]> {
  const id = pluginIdFromRequest(request);

  findUserPlugin(id);

  if (pluginHosts !== null) {
    await pluginHosts.disable(id);
  }

  await stopPluginBackend(id);

  return listPlugins();
}

/**
 * Closes plugin hosts on the way out; the process exit is the real deadline.
 * The table is cleared before the async stops so a second quit is a no-op.
 */
async function shutdownPlugins(): Promise<void> {
  const hosts = pluginHosts;
  pluginHosts = null;

  if (hosts !== null) {
    await shutdownHosts(hosts);
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
    serveAppProtocol({
      rendererRoot: RENDERER_ROOT,
      jobsRoot: JOBS_ROOT,
      pluginIds: jobPluginIds,
    });

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
  await shell.openPath(mirrorConfigPath(app.getPath('userData')));
});

/**
 * Closing stdin is how the backend learns to stop: its read loop ends on EOF, so
 * the process exits on its own instead of being killed mid-write.
 */
app.on('before-quit', () => {
  void shutdownPlugins();
  void shutdownBackend();
});
