import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { join } from 'node:path';

import {
  BackendError,
  createUtilityChannel,
  discoverPlugins,
  PluginHosts,
  type DiscoveryIssue,
  type PluginTransport,
} from '@felyrics/host';
import { asResult, parsePluginCall, parsePluginCommand } from './plugin-ipc.js';
import { mergePluginList } from './plugin-list.js';
import { APP_ENTRY_URL } from './app-assets.js';
import { registerAppScheme, serveAppProtocol } from './app-protocol.js';
import {
  callBackend,
  pingBackend,
  hostPaths,
  resolvePaths,
  shutdownBackend,
} from './backend.js';
import { enableBuiltinHosts } from './plugin-boot.js';
import type { PluginSummary } from '../preload/api.js';
import { describeFailure, runStartup, type StartupStatus } from './startup.js';

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

let pluginHosts: PluginHosts | null = null;
let pluginFailures: readonly DiscoveryIssue[] = [];
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

/** Runs the environment check, then opens the real window once it verifies. */
async function start(force = false): Promise<void> {
  if (starting) {
    return;
  }

  starting = true;

  try {
    const marker = await runStartup({
      paths: resolvePaths(),
      userDataDir: app.getPath('userData'),
      hostBackendRoot: hostPaths().hostBackendRoot,
      builtinPluginsRoot: hostPaths().builtinPluginsRoot,
      ...(force ? { force: true } : {}),
      onStatus: publishStatus,
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

  for (const issue of discovery.issues) {
    console.error('[plugin]', issue.directory, issue.code, issue.message);
  }

  const hosts = new PluginHosts(
    discovery.plugins.map((plugin) => plugin.manifest),
    {
      createChannel: (manifest): PluginTransport =>
        createUtilityChannel({
          fork: () =>
            utilityProcess.fork(UTILITY_ENTRY, [], { serviceName: manifest.id }),
        }),
      // The plugin never touches a window: the picker is a host service, answered
      // in the main process where the dialog lives.
      host: {
        pickFile: (options) => pickFile(options.kind),
        // One Python process holds every builtin plugin's backend for now, so the
        // host is the only party that can route a call to it.
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
  );

  pluginHosts = hosts;
  await enableBuiltinHosts(hosts, discovery.plugins);
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

/** One command invocation; commands take no parameters. */
async function commandPlugin(request: unknown): Promise<unknown> {
  if (pluginHosts === null) {
    throw new BackendError('core/not-ready', 'the plugin hosts are not enabled');
  }

  const { name, timeoutMs } = parsePluginCommand(request);

  return pluginHosts.command(name, timeoutMs);
}

/** Closes plugin hosts on the way out; the process exit is the real deadline. */
function shutdownPlugins(): void {
  const hosts = pluginHosts;
  pluginHosts = null;

  if (hosts === null) {
    return;
  }

  for (const plugin of hosts.list()) {
    if (plugin.state === 'ACTIVE' || plugin.state === 'LOADING') {
      void hosts.disable(plugin.id).catch(() => {});
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
    serveAppProtocol({ rendererRoot: RENDERER_ROOT, jobsRoot: JOBS_ROOT });

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

ipcMain.handle('plugin:command', (_event, request: unknown) =>
  asResult(() => commandPlugin(request)),
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

/**
 * Closing stdin is how the backend learns to stop: its read loop ends on EOF, so
 * the process exits on its own instead of being killed mid-write.
 */
app.on('before-quit', () => {
  shutdownPlugins();
  void shutdownBackend();
});
