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
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [audioLog, setAudioLog] = useState('no audio picked');
  const [videoLog, setVideoLog] = useState('no video picked');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [stillUrls, setStillUrls] = useState<readonly string[]>([]);

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

      <hr />

      <button
        type="button"
        onClick={() => {
          void window.felyrics.media.pick().then(async (picked) => {
            if (!picked.ok || picked.value === null) {
              setAudioLog(picked.ok ? 'cancelled' : show(picked));
              return;
            }

            setAudioPath(picked.value);
            setAudioLog('probing...');
            setAudioLog(show(await window.felyrics.media.probe(picked.value)));
          });
        }}
      >
        pick audio
      </button>
      <button
        type="button"
        disabled={audioPath === null}
        onClick={() => {
          if (audioPath === null) {
            return;
          }

          setAudioLog('decoding...');
          void window.felyrics.media
            .decode({ path: audioPath, rate: 16000, layout: 'mono' })
            .then((result) => {
              setAudioLog(show(result));
              // The proof that the whole chain works: the page loads the file
              // the backend wrote, over `app://job`, not from disk.
              setAudioUrl(result.ok ? result.value.url : null);
            });
        }}
      >
        decode 16k mono
      </button>
      <pre>{audioLog}</pre>
      {audioUrl !== null && <audio controls src={audioUrl} />}

      <hr />

      <button
        type="button"
        onClick={() => {
          void window.felyrics.video.pick().then(async (picked) => {
            if (!picked.ok || picked.value === null) {
              setVideoLog(picked.ok ? 'cancelled' : show(picked));
              return;
            }

            setVideoPath(picked.value);
            setVideoLog('probing...');
            setVideoLog(show(await window.felyrics.video.probe(picked.value)));
          });
        }}
      >
        pick video
      </button>
      <button
        type="button"
        disabled={videoPath === null}
        onClick={() => {
          if (videoPath === null) {
            return;
          }

          setVideoLog('decoding stills...');
          void window.felyrics.video
            .frames({ path: videoPath, count: 3, step: 0.5, width: 320 })
            .then((result) => {
              setVideoLog(show(result));
              setStillUrls(
                result.ok
                  ? result.value.frames
                      .map((frame) => frame.url)
                      .filter((url): url is string => url !== null)
                  : [],
              );
            });
        }}
      >
        grab 3 stills
      </button>
      <pre>{videoLog}</pre>
      {stillUrls.map((url) => (
        <img key={url} src={url} alt={url} width={320} />
      ))}
    </main>
  );
}
