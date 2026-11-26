/**
 * A fixture plugin: one public method, one backend method, no dependencies.
 * It exists so "enable, call, disable, enable again" can be exercised against a
 * real utility process and a real python process without shipping a feature.
 */
export async function activate(ctx) {
  ctx.method('echo', async (params) => {
    return ctx.backend.call('echo', params);
  });
}
