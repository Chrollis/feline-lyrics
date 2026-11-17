import { contextBridge, ipcRenderer } from 'electron';

import type { FelyricsApi } from './api.js';

const api: FelyricsApi = {
  ping: () => ipcRenderer.invoke('ping'),
  backendPing: () => ipcRenderer.invoke('backend:ping'),
};

contextBridge.exposeInMainWorld('felyrics', api);
