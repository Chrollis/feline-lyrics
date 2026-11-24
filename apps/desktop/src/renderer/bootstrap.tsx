import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type {
  BootstrapApi,
  BootstrapStatus,
} from '../preload/bootstrap.js';

declare global {
  interface Window {
    felyricsBootstrap: BootstrapApi;
  }
}

const STEPS = [
  ['uv', 'Download uv'],
  ['python', 'Install Python 3.12'],
  ['venv', 'Create the environment'],
  ['pth', 'Wire import paths'],
  ['packages', 'Install packages'],
  ['marker', 'Finalize'],
] as const;

function App() {
  const [status, setStatus] = useState<BootstrapStatus>({
    phase: 'checking',
    title: 'Checking the Python environment',
    log: [],
  });

  useEffect(() => window.felyricsBootstrap.onStatus(setStatus), []);

  const failed = status.phase === 'failed';

  return (
    <main>
      <h1>Felyrics</h1>
      <p>{status.title}</p>

      <ol>
        {STEPS.map(([id, label]) => (
          <li
            key={id}
            className={status.step === id ? 'active' : undefined}
          >
            {label}
          </li>
        ))}
      </ol>

      <pre>{status.log.slice(-6).join('\n')}</pre>

      {failed && (
        <>
          <p>
            {status.code}: {status.message}
          </p>
          <p>
            <button
              type="button"
              onClick={() => {
                void window.felyricsBootstrap.retry();
              }}
            >
              Retry
            </button>{' '}
            <button
              type="button"
              onClick={() => {
                void window.felyricsBootstrap.rebuild();
              }}
            >
              Rebuild
            </button>{' '}
            <button
              type="button"
              onClick={() => {
                void window.felyricsBootstrap.openLog();
              }}
            >
              Open log
            </button>{' '}
            <button
              type="button"
              onClick={() => {
                void window.felyricsBootstrap.quit();
              }}
            >
              Quit
            </button>
          </p>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
