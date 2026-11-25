import { useEffect, useState } from 'react';

import type { FelyricsApi, IpcResult } from '../preload/api.js';

declare global {
  interface Window {
    felyrics: FelyricsApi;
  }
}

/** A failure is data here, not a thrown exception: show its code. */
function show<T>(result: IpcResult<T>): string {
  return result.ok
    ? JSON.stringify(result.value, null, 2)
    : `${result.code}: ${result.message}`;
}

export function App() {
  const [reply, setReply] = useState('...');
  const [backend, setBackend] = useState('not asked');

  useEffect(() => {
    let cancelled = false;

    void window.felyrics.ping().then((value) => {
      if (!cancelled) {
        setReply(value);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Felyrics</h1>
      <p>main process says: {reply}</p>
      <button
        type="button"
        onClick={() => {
          setBackend('asking...');
          void window.felyrics.backendPing().then((result) => {
            setBackend(show(result));
          });
        }}
      >
        ping backend
      </button>
      <p>backend says: {backend}</p>
    </main>
  );
}
