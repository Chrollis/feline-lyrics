import { useEffect, useState } from 'react';

import type {
  FelyricsApi,
  IpcResult,
  PluginSummary,
} from '../preload/api.js';

declare global {
  interface Window {
    felyrics: FelyricsApi;
  }
}

function messageOf<T>(result: IpcResult<T>): string {
  return result.ok ? '' : `${result.code}: ${result.message}`;
}

export function App() {
  const [plugins, setPlugins] = useState<readonly PluginSummary[]>([]);
  const [notice, setNotice] = useState('');
  const [method, setMethod] = useState('');
  const [params, setParams] = useState('{}');
  const [answer, setAnswer] = useState('');

  const showList = (result: IpcResult<readonly PluginSummary[]>) => {
    if (result.ok) {
      setPlugins(result.value);
      setNotice('');
    } else {
      setNotice(messageOf(result));
    }
  };

  const call = () => {
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(params) as Record<string, unknown>;
    } catch {
      setAnswer('params: not JSON');
      return;
    }

    void window.felyrics.plugins
      .request({ name: method, params: parsed })
      .then((result) => {
        setAnswer(JSON.stringify(result, null, 2));
      });
  };

  useEffect(() => {
    void window.felyrics.plugins.list().then(showList);
  }, []);

  return (
    <main>
      <h1>Felyrics</h1>
      <section>
        <h2>Plugins</h2>
        <p>
          <button
            type="button"
            onClick={() => {
              void window.felyrics.plugins.install().then(showList);
            }}
          >
            Install from folder...
          </button>{' '}
          <button
            type="button"
            onClick={() => {
              void window.felyrics.plugins.folder();
            }}
          >
            Open plugin folder
          </button>
        </p>
        {notice === '' ? null : <p className="notice">{notice}</p>}
        <ul>
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <strong>{plugin.id}</strong> <span>{plugin.state}</span>
              {plugin.builtin === true ? <em> (builtin)</em> : null}{' '}
              {plugin.builtin === true ? null : plugin.state === 'ACTIVE' ? (
                <button
                  type="button"
                  onClick={() => {
                    void window.felyrics.plugins.disable(plugin.id).then(showList);
                  }}
                >
                  Disable
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void window.felyrics.plugins.enable(plugin.id).then(showList);
                  }}
                >
                  Enable
                </button>
              )}
              {plugin.message === undefined ? null : <p>{plugin.message}</p>}
              <p>{plugin.methods.join(', ') || 'no public methods'}</p>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Call a method</h2>
        <p>
          <input
            aria-label="method"
            placeholder="felyrics.media/probe"
            size={32}
            value={method}
            onChange={(event) => {
              setMethod(event.target.value);
            }}
          />
        </p>
        <p>
          <textarea
            aria-label="params"
            rows={4}
            cols={60}
            value={params}
            onChange={(event) => {
              setParams(event.target.value);
            }}
          />
        </p>
        <p>
          <button type="button" onClick={call}>
            Call
          </button>
        </p>
        <pre>{answer}</pre>
      </section>
    </main>
  );
}
