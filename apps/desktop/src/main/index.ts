import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { join } from 'node:path';

import { BackendError, ToolchainError } from '@felyrics/toolchain';

import type {
  AudioInfo,
  DecodedAudio,
  FrameBatch,
  IpcResult,
  VideoInfo,
} from '../preload/api.js';
import { callBackend, pingBackend, shutdownBackend } from './backend.js';

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

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
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

ipcMain.handle('ping', () => 'pong');

ipcMain.handle('backend:ping', () => asResult(() => pingBackend()));

// The path arrives as `unknown` on purpose: the backend validates it and answers
// `protocol/invalid-request`, so there is no second, weaker parser here.
ipcMain.handle('media:pick', () => asResult(() => pickFile('audio')));

ipcMain.handle('media:probe', (_event, path: unknown) =>
  asResult(() => callBackend<AudioInfo>('media/probe', { path })),
);

ipcMain.handle('media:decode', (_event, request: Record<string, unknown>) =>
  asResult(() => callBackend<DecodedAudio>('media/decode', request)),
);

ipcMain.handle('video:pick', () => asResult(() => pickFile('video')));

ipcMain.handle('video:probe', (_event, path: unknown) =>
  asResult(() => callBackend<VideoInfo>('video/probe', { path })),
);

ipcMain.handle('video:frames', (_event, request: Record<string, unknown>) =>
  asResult(() => callBackend<FrameBatch>('video/frames', request)),
);

/**
 * Closing stdin is how the backend learns to stop: its read loop ends on EOF, so
 * the process exits on its own instead of being killed mid-write.
 */
app.on('before-quit', () => {
  void shutdownBackend();
});
