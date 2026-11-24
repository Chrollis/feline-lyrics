import { servePlugin, type PluginHostTransport } from '@felyrics/host';

/**
 * The plugin host: one Electron utility process per plugin.
 *
 * It owns no window and no DOM; `process.parentPort` is the only channel it has,
 * and everything it runs comes from the manifest the main process sent. Keeping
 * this file this small is the point: the lifecycle lives in `@felyrics/host`,
 * where the tests can drive both ends of the channel in one process.
 */
const port = process.parentPort;

const transport: PluginHostTransport = {
  send(event) {
    port.postMessage(event);
  },
  onMessage(listener) {
    const handler = (message: Electron.MessageEvent): void => {
      listener(message.data);
    };

    port.on('message', handler);

    return () => {
      port.off('message', handler);
    };
  },
  // A utility process cannot outlive its parent, so there is nothing to observe.
  closed: new Promise<void>(() => {}),
  close() {
    // The `disposed` answer is queued on the port; give it a moment to leave
    // before the process goes away.
    setTimeout(() => {
      process.exit(0);
    }, 100);
  },
};

servePlugin(transport);
