import type { PluginContext } from '@felyrics/host';

/**
 * The backend methods this plugin exposes. The public name is the plugin id
 * plus the short name; the host adds the prefix, the source stays unprefixed.
 */
export const METHODS = [
  'probe',
  'decode',
  'video-probe',
  'video-frames',
] as const;

/**
 * Public methods with no backend counterpart: they ask the host to open the
 * native picker and return the chosen path. No state is kept here; the caller
 * passes the path back on the next call.
 */
export const PICKS = ['pick-audio', 'pick-video'] as const;

/**
 * A still batch can legitimately take minutes on a long video, so this call
 * carries its own budget; every other backend call has none.
 */
export const FRAMES_BUDGET_MS = 300_000;

/**
 * The plugin's TS face: one forwarding line per request method, with explicit
 * parameters.
 *
 * The body is deliberately empty of media logic. Probing and decoding belong to
 * the backend; everything the TS side could add here would be a second place
 * that knows what a frame count or a sample rate means. Picking is the only
 * operation that needs the host (the dialog lives in the main process), and it
 * holds no state either.
 */
export async function activate(ctx: PluginContext): Promise<void> {
  const backend = ctx.backend;

  if (backend === undefined) {
    throw new Error('felyrics.media declares a python backend');
  }

  for (const name of METHODS) {
    ctx.method(name, (params) =>
      backend.call(
        name,
        params,
        name === 'video-frames' ? { timeoutMs: FRAMES_BUDGET_MS } : undefined,
      ),
    );
  }

  ctx.method('pick-audio', () => ctx.host.pickFile({ kind: 'audio' }));
  ctx.method('pick-video', () => ctx.host.pickFile({ kind: 'video' }));
}
