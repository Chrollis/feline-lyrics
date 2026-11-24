// The plugin side of the utility channel, speaking Electron's parentPort
// protocol over Node's own IPC. It exists so the host side can be exercised
// against a real child process, without Electron.

import { servePlugin } from '@felyrics/host';

const transport = {
  send: (event) => {
    process.send?.(event);
  },
  onMessage: (listener) => {
    const handler = (message) => listener(message);
    process.on('message', handler);

    return () => process.off('message', handler);
  },
  closed: new Promise(() => {}),
  close: () => {
    process.disconnect();
  },
};

await servePlugin(transport);
