import { useEffect, useState } from 'react';

declare global {
  interface Window {
    felyrics: {
      ping: () => Promise<string>;
      backendPing: () => Promise<{ pong: boolean }>;
    };
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
            .then((value) => {
              setBackend(JSON.stringify(value));
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
