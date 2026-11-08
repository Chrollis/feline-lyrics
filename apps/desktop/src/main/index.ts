import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';

function createWindow(): void {
    const win = new BrowserWindow({
        width: 960,
        height: 640,
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

ipcMain.handle('ping', () => 'pong');
