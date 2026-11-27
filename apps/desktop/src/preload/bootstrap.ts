import { contextBridge, ipcRenderer } from 'electron';

/**
 * The startup window's bridge. Its only job is to show what the main process is
 * doing and offer the two recovery actions; it never decides when the app is
 * ready.
 */
export interface BootstrapStatus {
  readonly phase: 'checking' | 'installing' | 'verifying' | 'ready' | 'failed';
  readonly title: string;
  readonly step?: string;
  readonly log: readonly string[];
  readonly code?: string;
  readonly message?: string;
  /** The file this failure is about, when the user can edit it. */
  readonly configPath?: string;
}

export interface BootstrapApi {
  /** Subscribes and asks for the current status in one call. */
  onStatus(listener: (status: BootstrapStatus) => void): () => void;
  retry(): Promise<void>;
  rebuild(): Promise<void>;
  quit(): Promise<void>;
  openLog(): Promise<void>;
  openConfig(): Promise<void>;
}

const api: BootstrapApi = {
  onStatus(listener) {
    const handler = (_event: unknown, status: BootstrapStatus): void => {
      listener(status);
    };

    ipcRenderer.on('bootstrap:status', handler);
    // The run may have started before this page loaded; the main process keeps
    // the latest status and answers this after the subscription exists.
    ipcRenderer.send('bootstrap:ready');

    return () => {
      ipcRenderer.removeListener('bootstrap:status', handler);
    };
  },
  retry: () => ipcRenderer.invoke('bootstrap:retry'),
  rebuild: () => ipcRenderer.invoke('bootstrap:rebuild'),
  quit: () => ipcRenderer.invoke('bootstrap:quit'),
  openLog: () => ipcRenderer.invoke('bootstrap:open-log'),
  openConfig: () => ipcRenderer.invoke('bootstrap:open-config'),
};

contextBridge.exposeInMainWorld('felyricsBootstrap', api);
