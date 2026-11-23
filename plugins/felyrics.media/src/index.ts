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

/**
 * A still batch can legitimately take minutes on a long video; every other
 * method is bounded by the host's default budget.
 */
export const FRAMES_BUDGET_MS = 300_000;

/**
 * The plugin's TS face: one forwarding line per public method.
 *
 * The body is deliberately empty of logic. Probing and decoding belong to the
 * backend; everything the TS side could add here would be a second place that
 * knows what a frame count or a sample rate means.
 */
export async function activate(ctx: PluginContext): Promise<void> {
  ctx.method('probe', (params) => ctx.backend.call('probe', params));
  ctx.method('decode', (params) => ctx.backend.call('decode', params));
  ctx.method('video-probe', (params) => ctx.backend.call('video-probe', params));
  ctx.method('video-frames', (params) =>
    ctx.backend.call('video-frames', params, { timeoutMs: FRAMES_BUDGET_MS }),
  );
}
