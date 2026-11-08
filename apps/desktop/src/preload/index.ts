import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('felyrics', {
    ping: () => 'pong',
});
