import { basename } from 'node:path';

import type { PluginSummary } from '../preload/api.js';

/** The discovery failure shape the list needs; kept structural for the tests. */
export interface PluginIssueLike {
  readonly directory: string;
  readonly root: 'builtin' | 'user';
  readonly code: string;
  readonly message: string;
}

/**
 * Joins the live plugin hosts with the directories discovery refused.
 *
 * A failure keeps the directory's derived id when that id is free. When it
 * collides with a live plugin — the user copy of a builtin id is the usual, but
 * not the only, case — the row gets `<root>:<id>` so the list can show both
 * without the renderer silently dropping one.
 */
export function mergePluginList(
  hosts: readonly PluginSummary[],
  issues: readonly PluginIssueLike[],
): PluginSummary[] {
  const taken = new Set(hosts.map((plugin) => plugin.id));
  const failures = issues.map((issue) => {
    const derived = basename(issue.directory);
    const id = taken.has(derived) ? `${issue.root}:${derived}` : derived;

    taken.add(id);

    return {
      id,
      state: 'FAILED' as const,
      methods: [],
      message: `${issue.code}: ${issue.message}`,
    };
  });

  return [...hosts, ...failures];
}
