import { join, resolve } from 'node:path';

import { BackendError, discoverPlugins, issueId } from '@felyrics/host';
import {
  readRequirements,
  type PluginDoctorSpec,
} from '@felyrics/toolchain';

/**
 * What provisioning needs to know about the installed plugins, derived the same
 * way for `--setup`, `--doctor` and the app's startup window.
 *
 * The host backend is a native dependency, so it is not discovered: it is the
 * fixed first import path, and plugins only add theirs.
 */
export interface PluginEnvironment {
  /** `.pth` lines: the host backend, then every python plugin's backend. */
  readonly importPaths: readonly string[];
  /** The deduplicated union, in plugin-id order. */
  readonly requirements: readonly string[];
  /** One doctor spec per plugin that declares a python backend. */
  readonly plugins: readonly PluginDoctorSpec[];
}

export async function planEnvironment(
  hostBackendRoot: string,
  builtinPluginsRoot: string,
  pythonVersion?: string,
): Promise<PluginEnvironment> {
  // The environment still belongs to the builtin plugins: a user plugin gets
  // its own backend directory later (step 5), so it is discovered but its
  // requirements are not installed into the shared venv.
  const discovery = await discoverPlugins(
    [{ path: builtinPluginsRoot, kind: 'builtin' }],
    pythonVersion === undefined ? {} : { pythonVersion },
  );

  // A builtin plugin that cannot even be discovered is a startup failure, not a
  // row in a list: the app was built expecting it, and running without it is a
  // half-working install. User plugins get the FAILED row instead.
  const broken = discovery.issues.find((issue) => issue.root === 'builtin');

  if (broken !== undefined) {
    throw new BackendError(
      'core/backend-failed',
      `${issueId(broken)}: ${broken.code}: ${broken.message}`,
    );
  }

  const importPaths = [resolve(hostBackendRoot)];
  const requirements: string[] = [];
  const plugins: PluginDoctorSpec[] = [];

  for (const { manifest } of discovery.plugins) {
    if (manifest.python === undefined) {
      continue;
    }

    const backend = join(manifest.directory, 'backend');
    let declared: string[];

    try {
      declared = readRequirements(backend);
    } catch {
      throw new BackendError(
        'core/manifest-invalid',
        `plugin ${manifest.id} declares a python backend but has no backend/requirements.txt`,
      );
    }

    plugins.push({
      id: manifest.id,
      python: `${manifest.python.module}:${manifest.python.attribute}`,
      requirements: declared,
    });
    importPaths.push(resolve(backend));

    for (const requirement of declared) {
      if (!requirements.includes(requirement)) {
        requirements.push(requirement);
      }
    }
  }

  return { importPaths, requirements, plugins };
}
