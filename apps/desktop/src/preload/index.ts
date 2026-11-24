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
    command: (request) => ipcRenderer.invoke('plugin:command', request),
  },
  media: {
    pick: () => ipcRenderer.invoke('media:pick'),
    probe: (path) => ipcRenderer.invoke('media:probe', path),
    decode: (request) => ipcRenderer.invoke('media:decode', request),
  },
  video: {
    pick: () => ipcRenderer.invoke('video:pick'),
    probe: (path) => ipcRenderer.invoke('video:probe', path),
    frames: (request) => ipcRenderer.invoke('video:frames', request),
  },
};

contextBridge.exposeInMainWorld('felyrics', api);
