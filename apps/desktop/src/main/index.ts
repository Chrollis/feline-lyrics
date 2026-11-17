import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';

import { ToolchainError } from '@felyrics/toolchain';

import type { IpcResult } from '../preload/api.js';
import { pingBackend, shutdownBackend } from './backend.js';

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
 */
async function asResult<T>(run: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof ToolchainError ? error.code : 'ipc/unexpected',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

ipcMain.handle('ping', () => 'pong');

ipcMain.handle('backend:ping', () => asResult(() => pingBackend()));

/**
 * Closing stdin is how the backend learns to stop: its read loop ends on EOF, so
 * the process exits on its own instead of being killed mid-write.
 */
app.on('before-quit', () => {
  void shutdownBackend();
});
