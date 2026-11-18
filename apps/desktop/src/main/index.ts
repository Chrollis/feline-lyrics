import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { join } from 'node:path';

import { BackendError, ToolchainError } from '@felyrics/toolchain';

import type {
  AudioInfo,
  DecodedAudio,
  FrameBatch,
  FrameFile,
  IpcResult,
  VideoInfo,
} from '../preload/api.js';
import { APP_ENTRY_URL, mediaUrlFor } from './app-assets.js';
import { registerAppScheme, serveAppProtocol } from './app-protocol.js';
import {
  callBackend,
  pingBackend,
  resolvePaths,
  shutdownBackend,
} from './backend.js';

// Before `app.whenReady()`: the scheme registry is frozen at startup.
registerAppScheme();

/** Where the built renderer lives: `out/main/../renderer`. */
const RENDERER_ROOT = join(import.meta.dirname, '../renderer');

/** The backend's job directories, exactly as it was told at launch. */
const JOBS_ROOT = join(resolvePaths().cacheDir, 'jobs');

/**
 * The backend answers with paths; the page can only load URLs. Everything that
 * hands a file to the renderer goes through here, so no surface has to know how
 * a job directory becomes an origin.
 */
type BackendAudio = Omit<DecodedAudio, 'url'>;

type BackendFrames = Omit<FrameBatch, 'frames'> & {
  readonly frames: readonly Omit<FrameFile, 'url'>[];
};

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

app.whenReady().then(() => {
  serveAppProtocol({ rendererRoot: RENDERER_ROOT, jobsRoot: JOBS_ROOT });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * A rejected handler crosses the IPC boundary as a plain string, so the code the
 * toolchain carries is lost exactly here. Hand back the failure as a value
 * instead: the renderer can branch on `code` without parsing a message.
 *
 * Two vocabularies reach this point: the toolchain's own (`uv/*`, `target/*`) and
 * the backend's (`media/*`, `protocol/*`). Both keep their code; anything else is
 * a bug here, not a diagnosis.
 */
async function asResult<T>(run: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof ToolchainError || error instanceof BackendError
          ? error.code
          : 'ipc/unexpected',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const OPEN_FILE_FILTERS = {
  audio: [
    { name: 'Audio', extensions: ['flac', 'mp3', 'wav', 'm4a', 'ogg', 'opus'] },
  ],
  video: [{ name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov'] }],
} as const;

/** The native picker, because the renderer cannot see the filesystem at all. */
async function pickFile(kind: 'audio' | 'video'): Promise<string | null> {
  const options: OpenDialogOptions = {
    properties: ['openFile'],
    filters: OPEN_FILE_FILTERS[kind].map((filter) => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
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
// minutes on a long video, so it gets its own budget.
const BACKEND_TIMEOUT_MS = 30_000;
const FRAMES_TIMEOUT_MS = 300_000;

ipcMain.handle('ping', () => 'pong');

ipcMain.handle('backend:ping', () => asResult(() => pingBackend()));

// The path arrives as `unknown` on purpose: the backend validates it and answers
// `protocol/invalid-request`, so there is no second, weaker parser here.
ipcMain.handle('media:pick', () => asResult(() => pickFile('audio')));

ipcMain.handle('media:probe', (_event, path: unknown) =>
  asResult(() =>
    callBackend<AudioInfo>('media/probe', { path }, BACKEND_TIMEOUT_MS),
  ),
);

ipcMain.handle('media:decode', (_event, request: Record<string, unknown>) =>
  asResult(async () => {
    const audio = await callBackend<BackendAudio>(
      'media/decode',
      request,
      BACKEND_TIMEOUT_MS,
    );

    return { ...audio, url: mediaUrlFor(JOBS_ROOT, audio.path) };
  }),
);

ipcMain.handle('video:pick', () => asResult(() => pickFile('video')));

ipcMain.handle('video:probe', (_event, path: unknown) =>
  asResult(() =>
    callBackend<VideoInfo>('video/probe', { path }, BACKEND_TIMEOUT_MS),
  ),
);

ipcMain.handle('video:frames', (_event, request: Record<string, unknown>) =>
  asResult(async () => {
    const batch = await callBackend<BackendFrames>(
      'video/frames',
      request,
      FRAMES_TIMEOUT_MS,
    );

    return {
      ...batch,
      frames: batch.frames.map((frame) => ({
        ...frame,
        url: mediaUrlFor(JOBS_ROOT, frame.path),
      })),
    };
  }),
);

/**
 * Closing stdin is how the backend learns to stop: its read loop ends on EOF, so
 * the process exits on its own instead of being killed mid-write.
 */
app.on('before-quit', () => {
  void shutdownBackend();
});
