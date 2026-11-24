import type { PluginContext } from '@felyrics/host';

/**
 * The internal method names the Python backend registers; each one is also
 * public under the plugin id, and the host owns that prefix.
 */
export const METHODS = [
  'probe',
  'decode',
  'video-probe',
  'video-frames',
] as const;

/** The buttons the host draws for this plugin, in card order. */
export const COMMANDS = [
  'pick-audio',
  'decode-audio',
  'pick-video',
  'frames-video',
] as const;

/**
 * A still batch can legitimately take minutes on a long video; every other
 * method is bounded by the host's default budget.
 */
export const FRAMES_BUDGET_MS = 300_000;

/** The sample card asks for a handful of stills, not a scrub bar's worth. */
export const SAMPLE_FRAMES = 4;

/**
 * A command that runs before the card has picked a file is a caller mistake, not
 * a crash: the code is declared in `contributes.errors`.
 */
function refuse(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'felyrics.media/bad-request',
  });
}

/**
 * The plugin's TS face: one forwarding line per public method, plus the four
 * commands the sample cards drive.
 *
 * The body is deliberately empty of media logic. Probing and decoding belong to
 * the backend; everything the TS side could add here would be a second place
 * that knows what a frame count or a sample rate means. The only state is the
 * last path the user picked, which is a fact about the UI session, not about
 * the media.
 */
export async function activate(ctx: PluginContext): Promise<void> {
  const backend = ctx.backend;

  if (backend === undefined) {
    throw new Error('felyrics.media declares a python backend');
  }

  let audio: string | null = null;
  let video: string | null = null;

  ctx.method('probe', (params) => backend.call('probe', params));
  ctx.method('decode', (params) => backend.call('decode', params));
  ctx.method('video-probe', (params) => backend.call('video-probe', params));
  ctx.method('video-frames', (params) =>
    backend.call('video-frames', params, { timeoutMs: FRAMES_BUDGET_MS }),
  );

  ctx.command('pick-audio', async () => {
    const picked = await ctx.host.pickFile({ kind: 'audio' });

    if (picked !== null) {
      audio = picked;
    }

    return picked;
  });

  ctx.command('decode-audio', async () => {
    if (audio === null) {
      throw refuse('pick an audio file first');
    }

    return backend.call('decode', { path: audio });
  });

  ctx.command('pick-video', async () => {
    const picked = await ctx.host.pickFile({ kind: 'video' });

    if (picked !== null) {
      video = picked;
    }

    return picked;
  });

  ctx.command('frames-video', async () => {
    if (video === null) {
      throw refuse('pick a video file first');
    }

    return backend.call(
      'video-frames',
      { path: video, count: SAMPLE_FRAMES },
      { timeoutMs: FRAMES_BUDGET_MS },
    );
  });
}
