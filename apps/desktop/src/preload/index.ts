import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('felyrics', {
  ping: () => ipcRenderer.invoke('ping'),
});
