import { useEffect, useState } from 'react';

import type { FelyricsApi } from '../preload/api.js';

declare global {
  interface Window {
    felyrics: FelyricsApi;
  }
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
          window.felyrics
            .backendPing()
            .then((result) => {
              setBackend(
                result.ok
                  ? JSON.stringify(result.value)
                  : `${result.code}: ${result.message}`,
              );
            })
            .catch((error: unknown) => {
              setBackend(String(error));
            });
        }}
      >
        ping backend
      </button>
      <p>backend says: {backend}</p>
    </main>
  );
}
