import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * The plugin manifest, validated before a line of plugin code runs.
 *
 * This is the TypeScript mirror of `felyrics_host/manifest.py`: the two sides
 * read the same package.json and must reach the same verdict. The rules are the
 * ones in `reference/ideas/plugin-api-draft.md` section 3 -- `package.json` is
 * the only manifest, unknown keys inside `felyrics` are refused, and every
 * problem is collected into one error so an author fixes one list rather than
 * one field per run.
 */

export const PLUGIN_API = 1;
export const PLUGIN_HOSTS = ['renderer', 'utility'] as const;
export const WORKER_LIMIT = 8;

export type PluginHost = (typeof PLUGIN_HOSTS)[number];

/** One button the host draws; the handler lives in `activate`. */
export interface CommandContribution {
  readonly id: string;
  readonly title: string;
}

/** The `python` key of `felyrics.backend`, already split at the colon. */
export interface PythonTarget {
  readonly module: string;
  readonly attribute: string;
}

export interface PluginManifest {
  /** `<publisher>.<name>` or `<scope>.<name>`; the plugin directory is named it. */
  readonly id: string;
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly api: number;
  readonly host: PluginHost;
  /** The TypeScript entry point, relative to the package directory. */
  readonly main: string;
  readonly types?: string;
  readonly python?: PythonTarget;
  readonly enginesPython?: string;
  readonly methods: readonly string[];
  readonly internal: readonly string[];
  readonly commands: readonly CommandContribution[];
  readonly errors: readonly string[];
  readonly jobs: readonly string[];
}

export interface ManifestIssue {
  readonly path: string;
  readonly message: string;
}

export type ManifestErrorCode =
  | 'core/manifest-invalid'
  | 'core/identity-mismatch'
  | 'core/api-unsupported'
  | 'core/engine-unsatisfied'
  | 'core/duplicate-id';

export class ManifestError extends Error {
  readonly code: ManifestErrorCode;
  readonly issues: readonly ManifestIssue[];

  constructor(
    code: ManifestErrorCode,
    message: string,
    issues: readonly ManifestIssue[] = [],
  ) {
    super(message);
    this.name = 'ManifestError';
    this.code = code;
    this.issues = issues;
  }
}

export interface LoadManifestOptions {
  /** The interpreter that will run the backend, as `major.minor`. */
  readonly pythonVersion?: string;
}

const SHORT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const ATTRIBUTE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ENGINE = /^(>=|<=|==|>|<)(\d+)\.(\d+)$/;

const FELYRICS_KEYS = new Set([
  'api',
  'host',
  'backend',
  'engines',
  'workers',
  'contributes',
]);
const BACKEND_KEYS = new Set(['python', 'exec']);
const CONTRIBUTES_KEYS = new Set([
  'methods',
  'internal',
  'errors',
  'jobs',
  'commands',
]);
const COMMAND_KEYS = new Set(['id', 'title']);

export function isShortName(value: unknown): value is string {
  return typeof value === 'string' && SHORT.test(value);
}

/** Reads and validates `<directory>/package.json`; every problem is collected. */
export async function loadManifest(
  directory: string,
  options: LoadManifestOptions = {},
): Promise<PluginManifest> {
  const root = resolve(directory);
  const issues: ManifestIssue[] = [];
  const packageJson = await readPackage(root, issues);

  if (issues.length > 0) {
    throw invalid(issues);
  }

  const felyrics = packageJson['felyrics'];

  if (!isRecord(felyrics)) {
    issue(issues, 'felyrics', 'must be an object');
    throw invalid(issues);
  }

  refuseUnknown(felyrics, FELYRICS_KEYS, 'felyrics', issues);

  const name = text(packageJson['name'], 'name', issues);
  const publisher = text(packageJson['publisher'], 'publisher', issues, false);
  const id = name !== null ? deriveId(name, publisher, issues) : null;

  const version = text(packageJson['version'], 'version', issues);

  if (version !== null && !SEMVER.test(version)) {
    issue(issues, 'version', 'must be semver, for example 0.1.0');
  }

  text(packageJson['author'], 'author', issues);
  const main = relative(packageJson['main'], 'main', issues);
  const types = relative(packageJson['types'], 'types', issues, false);

  const apiValue = felyrics['api'];
  let api: number | null = null;

  if (typeof apiValue !== 'number' || !Number.isInteger(apiValue)) {
    issue(issues, 'felyrics.api', 'must be an integer');
  } else {
    api = apiValue;
  }

  const hostValue = felyrics['host'];
  let host: PluginHost | null = null;

  if (
    typeof hostValue !== 'string' ||
    !(PLUGIN_HOSTS as readonly string[]).includes(hostValue)
  ) {
    issue(issues, 'felyrics.host', `must be one of ${PLUGIN_HOSTS.join(', ')}`);
  } else {
    host = hostValue as PluginHost;
  }

  const backend = felyrics['backend'];
  let backendLabel: 'python' | null = null;
  let python: PythonTarget | null = null;

  if (backend !== undefined) {
    if (!isRecord(backend)) {
      issue(issues, 'felyrics.backend', 'must be an object');
    } else {
      refuseUnknown(backend, BACKEND_KEYS, 'felyrics.backend', issues);

      if ('exec' in backend) {
        issue(
          issues,
          'felyrics.backend.exec',
          'is not a backend in v0; start a helper from the python backend',
        );
      }

      if ('python' in backend) {
        backendLabel = 'python';
        const target = text(
          backend['python'],
          'felyrics.backend.python',
          issues,
        );

        if (target !== null) {
          const [module, attribute, extra] = target.split(':');

          if (
            extra !== undefined ||
            module === undefined ||
            attribute === undefined ||
            !MODULE.test(module) ||
            !ATTRIBUTE.test(attribute)
          ) {
            issue(
              issues,
              'felyrics.backend.python',
              "must be 'module:callable'",
            );
          } else {
            python = { module, attribute };
          }
        }
      }
    }
  }

  const engines = felyrics['engines'];
  let enginesPython: string | null = null;

  if (backendLabel === 'python') {
    if (!isRecord(engines)) {
      issue(issues, 'felyrics.engines', 'is required with a python backend');
    } else {
      refuseUnknown(engines, new Set(['python']), 'felyrics.engines', issues);
      const spec = text(engines['python'], 'felyrics.engines.python', issues);

      if (spec !== null) {
        if (!spec.split(',').every((part) => ENGINE.test(part.trim()))) {
          issue(
            issues,
            'felyrics.engines.python',
            'must be a comma separated list like >=3.12',
          );
        } else {
          enginesPython = spec;
        }
      }
    }
  } else if (engines !== undefined) {
    issue(
      issues,
      'felyrics.engines',
      'is only allowed with a python backend',
    );
  }

  const workers = felyrics['workers'];

  if (workers !== undefined) {
    if (!isRecord(workers)) {
      issue(issues, 'felyrics.workers', 'must be an object');
    } else {
      if (Object.keys(workers).length > WORKER_LIMIT) {
        issue(
          issues,
          'felyrics.workers',
          `at most ${WORKER_LIMIT} workers per plugin`,
        );
      }

      for (const [workerName, entry] of Object.entries(workers)) {
        const path = `felyrics.workers.${workerName}`;

        if (!isShortName(workerName)) {
          issue(issues, path, 'must be lowercase kebab');
        } else {
          relative(entry, path, issues);
        }
      }
    }
  }

  const contributes = felyrics['contributes'];
  let methods: string[] = [];
  let internal: string[] = [];
  let commands: CommandContribution[] = [];
  let errors: string[] = [];
  let jobs: string[] = [];

  if (!isRecord(contributes)) {
    issue(
      issues,
      'felyrics.contributes',
      'is required and must be an object',
    );
  } else {
    refuseUnknown(contributes, CONTRIBUTES_KEYS, 'felyrics.contributes', issues);
    methods = shortList({
      container: contributes,
      key: 'methods',
      path: 'felyrics.contributes.methods',
      issues,
      required: true,
      nonEmpty: true,
    });
    internal = shortList({
      container: contributes,
      key: 'internal',
      path: 'felyrics.contributes.internal',
      issues,
      required: backendLabel !== null,
      forbidden: backendLabel === null,
    });
    errors = shortList({
      container: contributes,
      key: 'errors',
      path: 'felyrics.contributes.errors',
      issues,
    });
    jobs = shortList({
      container: contributes,
      key: 'jobs',
      path: 'felyrics.contributes.jobs',
      issues,
    });
    commands = commandList(contributes['commands'], issues);
  }

  if (issues.length > 0) {
    throw invalid(issues);
  }

  const pluginId = id as string;

  if (resolve(root).split(/[\\/]/).pop() !== pluginId) {
    throw new ManifestError(
      'core/identity-mismatch',
      `directory does not hold plugin ${pluginId}`,
      [
        {
          path: 'directory',
          message: `expected ${pluginId}`,
        },
      ],
    );
  }

  if (api !== PLUGIN_API) {
    throw new ManifestError(
      'core/api-unsupported',
      `plugin ${pluginId} declares api ${api}; this host supports ${PLUGIN_API}`,
      [{ path: 'felyrics.api', message: String(api) }],
    );
  }

  if (
    enginesPython !== null &&
    options.pythonVersion !== undefined &&
    !satisfiesEngine(enginesPython, options.pythonVersion)
  ) {
    throw new ManifestError(
      'core/engine-unsatisfied',
      `plugin ${pluginId} needs python ${enginesPython}; this process is ${options.pythonVersion}`,
      [{ path: 'felyrics.engines.python', message: enginesPython }],
    );
  }

  return {
    id: pluginId,
    directory: root,
    name: name as string,
    version: version as string,
    author: packageJson['author'] as string,
    api: api as number,
    host: host as PluginHost,
    main: main as string,
    ...(types !== null ? { types } : {}),
    ...(python !== null ? { python } : {}),
    ...(enginesPython !== null ? { enginesPython } : {}),
    methods,
    internal,
    commands,
    errors,
    jobs,
  };
}

async function readPackage(
  directory: string,
  issues: ManifestIssue[],
): Promise<Record<string, unknown>> {
  let text_: string;

  try {
    text_ = await readFile(join(directory, 'package.json'), 'utf8');
  } catch (error) {
    issue(issues, 'package.json', `cannot read: ${(error as Error).message}`);

    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text_);
  } catch (error) {
    issue(issues, 'package.json', `is not JSON: ${(error as Error).message}`);

    return {};
  }

  if (!isRecord(parsed)) {
    issue(issues, 'package.json', 'must contain a JSON object');

    return {};
  }

  return parsed;
}

function deriveId(
  name: string,
  publisher: string | null,
  issues: ManifestIssue[],
): string | null {
  if (name.startsWith('@')) {
    const [scope, short, extra] = name.slice(1).split('/');

    if (
      extra !== undefined ||
      scope === undefined ||
      short === undefined ||
      scope === '' ||
      short === ''
    ) {
      issue(issues, 'name', 'a scoped name is written @scope/name');

      return null;
    }

    if (!SHORT.test(scope) || !SHORT.test(short)) {
      issue(issues, 'name', 'each segment must be lowercase kebab');

      return null;
    }

    if (publisher !== null) {
      issue(issues, 'publisher', 'a scoped name must not declare publisher');
    }

    return `${scope}.${short}`;
  }

  if (!SHORT.test(name)) {
    issue(issues, 'name', 'must be lowercase kebab');

    return null;
  }

  if (publisher === null) {
    issue(issues, 'publisher', 'a plain name requires publisher');

    return null;
  }

  if (!SHORT.test(publisher)) {
    issue(issues, 'publisher', 'must be lowercase kebab');

    return null;
  }

  return `${publisher}.${name}`;
}

function satisfiesEngine(spec: string, version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);

  if (match === null) {
    return false;
  }

  const current: [number, number] = [Number(match[1]), Number(match[2])];

  return spec.split(',').every((part) => {
    const clause = ENGINE.exec(part.trim());

    if (clause === null) {
      return false;
    }

    const [, operator, major, minor] = clause;
    const target: [number, number] = [Number(major), Number(minor)];
    const [a, b] = current;
    const [c, d] = target;

    switch (operator) {
      case '>=':
        return a > c || (a === c && b >= d);
      case '<=':
        return a < c || (a === c && b <= d);
      case '>':
        return a > c || (a === c && b > d);
      case '<':
        return a < c || (a === c && b < d);
      default:
        return a === c && b === d;
    }
  });
}

function text(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
  required = true,
): string | null {
  if (value === undefined) {
    if (required) {
      issue(issues, path, 'is required');
    }

    return null;
  }

  if (typeof value !== 'string' || value.length === 0) {
    issue(issues, path, 'must be a non-empty string');

    return null;
  }

  return value;
}

function relative(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
  required = true,
): string | null {
  const candidate = text(value, path, issues, required);

  if (candidate === null) {
    return null;
  }

  if (isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..')) {
    issue(issues, path, 'must stay inside the package');

    return null;
  }

  return candidate;
}

interface ShortListInput {
  readonly container: Record<string, unknown>;
  readonly key: string;
  readonly path: string;
  readonly issues: ManifestIssue[];
  readonly required?: boolean;
  readonly nonEmpty?: boolean;
  readonly forbidden?: boolean;
}

function shortList(input: ShortListInput): string[] {
  const { container, key, path, issues } = input;

  if (!(key in container)) {
    if (input.required === true) {
      issue(issues, path, 'is required');
    }

    return [];
  }

  if (input.forbidden === true) {
    issue(issues, path, 'is not allowed without a backend');

    return [];
  }

  const value = container[key];

  if (!Array.isArray(value)) {
    issue(issues, path, 'must be an array of names');

    return [];
  }

  const names: string[] = [];

  value.forEach((item, index) => {
    if (!isShortName(item)) {
      issue(issues, `${path}[${index}]`, 'must be lowercase kebab');
    } else if (names.includes(item)) {
      issue(issues, `${path}[${index}]`, `${item} is listed twice`);
    } else {
      names.push(item);
    }
  });

  if (input.nonEmpty === true && names.length === 0) {
    issue(issues, path, 'must declare at least one name');
  }

  return names;
}

function commandList(value: unknown, issues: ManifestIssue[]): CommandContribution[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    issue(issues, 'felyrics.contributes.commands', 'must be an array');

    return [];
  }

  const commands: CommandContribution[] = [];
  const seen = new Set<string>();

  value.forEach((item, index) => {
    const path = `felyrics.contributes.commands[${index}]`;

    if (!isRecord(item)) {
      issue(issues, path, 'must be an object');

      return;
    }

    refuseUnknown(item, COMMAND_KEYS, path, issues);

    const id = text(item['id'], `${path}.id`, issues);
    const title = text(item['title'], `${path}.title`, issues);

    if (id !== null && !isShortName(id)) {
      issue(issues, `${path}.id`, 'must be lowercase kebab');
    } else if (id !== null) {
      if (seen.has(id)) {
        issue(issues, `${path}.id`, `${id} is listed twice`);
      } else {
        seen.add(id);

        if (title !== null) {
          commands.push({ id, title });
        }
      }
    }
  });

  return commands;
}

function refuseUnknown(
  container: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ManifestIssue[],
): void {
  for (const key of Object.keys(container)) {
    if (!allowed.has(key)) {
      issue(
        issues,
        `${path}.${key}`,
        `unknown key; allowed: ${[...allowed].sort().join(', ')}`,
      );
    }
  }
}

function issue(
  issues: ManifestIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

function invalid(issues: ManifestIssue[]): ManifestError {
  return new ManifestError(
    'core/manifest-invalid',
    `the manifest has ${issues.length} problem(s)`,
    issues,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
