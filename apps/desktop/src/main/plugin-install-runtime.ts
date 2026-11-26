import type { PluginHosts, PluginManifest } from '@felyrics/host';

import type { PluginSummary } from '../preload/api.js';

/** What an install has to touch besides the disk. */
export interface InstalledPluginRuntime {
  readonly pluginsRoot: string;
  readonly install: (
    source: string,
    pluginsRoot: string,
    deps: { readonly knownIds: ReadonlySet<string> },
  ) => Promise<PluginManifest>;
  readonly discovered: () => readonly { manifest: PluginManifest }[];
  readonly addDiscovered: (manifest: PluginManifest) => void;
  readonly jobIds: { add(id: string): void };
  readonly hosts: () => PluginHosts | null;
  readonly addUserBackend: (plugin: { id: string; directory: string }) => void;
  readonly list: () => readonly PluginSummary[];
}

/**
 * Copies a picked plugin into the user root and wires it into the live app.
 *
 * The copy alone leaves a plugin that lists as PENDING but cannot be called;
 * the job id and the backend route are the two pieces that make "install then
 * enable" work without a restart. Kept out of `index.ts` so a test can drive
 * the same glue with a real hosts table and a fake backend pool.
 */
export async function installPickedPlugin(
  source: string,
  runtime: InstalledPluginRuntime,
): Promise<readonly PluginSummary[]> {
  const manifest = await runtime.install(source, runtime.pluginsRoot, {
    knownIds: new Set(
      runtime.discovered().map((plugin) => plugin.manifest.id),
    ),
  });

  if (
    !runtime.discovered().some((plugin) => plugin.manifest.id === manifest.id)
  ) {
    runtime.addDiscovered(manifest);
  }

  runtime.jobIds.add(manifest.id);
  runtime.hosts()?.add(manifest);
  runtime.addUserBackend({ id: manifest.id, directory: manifest.directory });

  return runtime.list();
}
