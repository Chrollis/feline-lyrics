import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The sample cards hard-code two plugin command names and read two answers.
 * They are a demonstration, not a renderer for arbitrary plugins: a plugin's
 * answer is JSON, and only the plugin knows what its fields mean.
 */
function audioUrlOf(value: unknown): string | null {
  return isRecord(value) && typeof value['url'] === 'string'
    ? value['url']
    : null;
}

function stillUrlsOf(value: unknown): readonly string[] {
  if (!isRecord(value) || !Array.isArray(value['frames'])) {
    return [];
  }

  const urls: string[] = [];

  for (const frame of value['frames']) {
    if (isRecord(frame) && typeof frame['url'] === 'string') {
      urls.push(frame['url']);
    }
  }

  return urls;
}

function Card(props: {
  readonly title: string;
  readonly buttons: ReactNode;
  readonly log: string;
  readonly children?: ReactNode;
}) {
  return (
    <section>
      <h2>{props.title}</h2>
      <p>{props.buttons}</p>
      <pre>{props.log}</pre>
      {props.children}
    </section>
  );
}

export function App() {
  const [reply, setReply] = useState('...');
  const [backend, setBackend] = useState('not asked');
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [audioLog, setAudioLog] = useState('no audio picked');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoLog, setVideoLog] = useState('no video picked');
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

  const pickAudio = async () => {
    setAudioLog('picking...');

    const result = await window.felyrics.plugins.command({
      name: 'felyrics.media/pick-audio',
    });

    if (!result.ok) {
      setAudioLog(show(result));

      return;
    }

    const picked = result.value;

    if (typeof picked === 'string') {
      setAudioPath(picked);
      setAudioLog(`picked: ${picked}`);
    } else {
      setAudioLog('cancelled');
    }
  };

  const decodeAudio = async () => {
    setAudioLog('decoding...');

    const result = await window.felyrics.plugins.command({
      name: 'felyrics.media/decode-audio',
    });

    setAudioLog(show(result));
    setAudioUrl(result.ok ? audioUrlOf(result.value) : null);
  };

  const pickVideo = async () => {
    setVideoLog('picking...');

    const result = await window.felyrics.plugins.command({
      name: 'felyrics.media/pick-video',
    });

    if (!result.ok) {
      setVideoLog(show(result));

      return;
    }

    const picked = result.value;

    if (typeof picked === 'string') {
      setVideoPath(picked);
      setVideoLog(`picked: ${picked}`);
    } else {
      setVideoLog('cancelled');
    }
  };

  const framesVideo = async () => {
    setVideoLog('decoding stills...');

    const result = await window.felyrics.plugins.command({
      name: 'felyrics.media/frames-video',
    });

    setVideoLog(show(result));
    setStillUrls(result.ok ? stillUrlsOf(result.value) : []);
  };

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

      <Card
        title="Audio"
        buttons={
          <>
            <button type="button" onClick={pickAudio}>
              Pick audio
            </button>{' '}
            <button
              type="button"
              disabled={audioPath === null}
              onClick={decodeAudio}
            >
              Decode audio
            </button>
          </>
        }
        log={audioLog}
      >
        {/* The proof that the whole chain works: the page loads the file the
            backend wrote, over `app://job`, not from disk. */}
        {audioUrl !== null && <audio controls src={audioUrl} />}
      </Card>

      <Card
        title="Video"
        buttons={
          <>
            <button type="button" onClick={pickVideo}>
              Pick video
            </button>{' '}
            <button
              type="button"
              disabled={videoPath === null}
              onClick={framesVideo}
            >
              Frames video
            </button>
          </>
        }
        log={videoLog}
      >
        {stillUrls.map((url) => (
          <img key={url} src={url} alt={url} width={320} />
        ))}
      </Card>
    </main>
  );
}
