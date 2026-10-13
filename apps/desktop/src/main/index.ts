import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

function createWindow(): void {
    const window = new BrowserWindow({
        width: 960,
        height: 640,
        show: false,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    window.once('ready-to-show', () => {
        window.show();
    });

    if (process.env.ELECTRON_RENDERER_URL) {
        window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
        window.loadFile(join(__dirname, '../renderer/index.html'));
    }
}

app.whenReady().then(() => {
    createWindow();
});
