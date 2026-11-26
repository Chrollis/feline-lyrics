import { contextBridge, ipcRenderer } from 'electron';

import type { FelyricsApi } from './api.js';

/**
 * Every method is a channel name plus `ipcRenderer.invoke`: the main process owns
 * the question, this file only names it. Nothing here may compute a result, or
 * the two sides would each have half a rule.
 */
const api: FelyricsApi = {
  ping: () => ipcRenderer.invoke('ping'),
  backendPing: () => ipcRenderer.invoke('backend:ping'),
  plugins: {
    list: () => ipcRenderer.invoke('plugin:list'),
    request: (request) => ipcRenderer.invoke('plugin:request', request),
    enable: (id) => ipcRenderer.invoke('plugin:enable', { id }),
    disable: (id) => ipcRenderer.invoke('plugin:disable', { id }),
  },
};

contextBridge.exposeInMainWorld('felyrics', api);
