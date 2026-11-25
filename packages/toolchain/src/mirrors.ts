import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ToolchainError } from './errors.js';

/** Where each kind of download may come from, in fallback order. */
export interface MirrorSources {
  /** Templates for the uv zip; must contain `{asset}`. */
  readonly uv?: readonly string[];
  /**
   * Templates for the python-build-standalone tarball. Either `{tag}` and
   * `{asset}` (a mirror that lists tags itself), or `{url}` (a proxy that wants
   * the complete official asset URL); the listing then stays on GitHub.
   */
  readonly python?: readonly string[];
  /** Package index URLs, primary first. */
  readonly packages?: readonly string[];
}

export interface MirrorReleasePolicy {
  /** `"latest"` or an eight digit python-build-standalone tag. */
  readonly python?: string;
}

/** The on-disk shape of `mirrors.json`. Everything is optional. */
export interface MirrorConfig {
  readonly sources?: MirrorSources;
  readonly release?: MirrorReleasePolicy;
}

/** The value the rest of the toolchain consumes: defaults already filled in. */
export interface ResolvedMirrorConfig {
  readonly uv: readonly string[];
  readonly python: readonly string[];
  readonly packages: readonly string[];
  readonly pythonRelease: string;
}

/**
 * The built-in sources are the official ones only. Mirrors change paths and
 * sometimes guard large files behind a browser challenge (USTC does), so they
 * belong in the user's config, not in the repository.
 */
export const DEFAULT_MIRRORS: ResolvedMirrorConfig = {
  uv: ['https://github.com/astral-sh/uv/releases/latest/download/{asset}'],
  python: [
    'https://github.com/astral-sh/python-build-standalone/releases/download/{tag}/{asset}',
  ],
  packages: ['https://pypi.org/simple'],
  pythonRelease: 'latest',
};

const TOP_LEVEL_KEYS = new Set(['sources', 'release']);
const SOURCE_KEYS = new Set(['uv', 'python', 'packages']);
const RELEASE_KEYS = new Set(['python']);
const TAG_PATTERN = /^\d{8}$/;

function invalid(path: string, message: string): never {
  throw new ToolchainError('mirrors/invalid', message, { path });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) {
    invalid(path, `${path} must be an object`);
  }

  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`${path}.${key}`, `unknown key ${key} in ${path}`);
    }
  }
}

function httpUrl(value: string, path: string): string {
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    invalid(path, `${path} must start with http:// or https://`);
  }

  return value;
}

function templates(
  value: unknown,
  path: string,
  required: readonly string[],
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(path, `${path} must be a non-empty array of URL templates`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      invalid(`${path}[${index}]`, `${path}[${index}] must be a non-empty string`);
    }

    httpUrl(entry, `${path}[${index}]`);

    for (const placeholder of required) {
      if (!entry.includes(`{${placeholder}}`)) {
        invalid(
          `${path}[${index}]`,
          `${path}[${index}] must contain {${placeholder}}`,
        );
      }
    }

    return entry;
  });
}

/**
 * Python sources come in two shapes, and mixing them in one entry is a typo:
 * `{tag}`/`{asset}` names the file on the mirror, while `{url}` hands the whole
 * official URL to a download proxy.
 */
function pythonTemplates(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(path, `${path} must be a non-empty array of URL templates`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      invalid(`${path}[${index}]`, `${path}[${index}] must be a non-empty string`);
    }

    httpUrl(entry, `${path}[${index}]`);

    const templated = entry.includes('{url}');

    if (templated) {
      if (entry.includes('{tag}') || entry.includes('{asset}')) {
        invalid(
          `${path}[${index}]`,
          `${path}[${index}] must use either {url} or {tag} and {asset}`,
        );
      }
    } else {
      for (const placeholder of ['tag', 'asset']) {
        if (!entry.includes(`{${placeholder}}`)) {
          invalid(
            `${path}[${index}]`,
            `${path}[${index}] must contain {${placeholder}} or {url}`,
          );
        }
      }
    }

    return entry;
  });
}

function packageIndexes(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(path, `${path} must be a non-empty array of package index URLs`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      invalid(`${path}[${index}]`, `${path}[${index}] must be a non-empty string`);
    }

    if (entry.includes('{')) {
      invalid(`${path}[${index}]`, `${path}[${index}] cannot contain a placeholder`);
    }

    return httpUrl(entry, `${path}[${index}]`);
  });
}

/**
 * Parses and validates `mirrors.json`.
 *
 * Unknown keys are refused: the file is hand-written, and a silent typo would
 * surface later as a download that quietly used the wrong source.
 */
export function parseMirrorConfig(text: string): MirrorConfig {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    invalid('mirrors.json', `mirrors.json is not valid JSON: ${String(error)}`);
  }

  const root = assertObject(parsed, 'mirrors.json');
  assertKeys(root, TOP_LEVEL_KEYS, 'mirrors.json');

  const config: {
    sources?: MirrorSources;
    release?: MirrorReleasePolicy;
  } = {};

  if (root.sources !== undefined) {
    const sources = assertObject(root.sources, 'sources');
    assertKeys(sources, SOURCE_KEYS, 'sources');

    config.sources = {
      ...(sources.uv === undefined
        ? {}
        : { uv: templates(sources.uv, 'sources.uv', ['asset']) }),
      ...(sources.python === undefined
        ? {}
        : { python: pythonTemplates(sources.python, 'sources.python') }),
      ...(sources.packages === undefined
        ? {}
        : { packages: packageIndexes(sources.packages, 'sources.packages') }),
    };
  }

  if (root.release !== undefined) {
    const release = assertObject(root.release, 'release');
    assertKeys(release, RELEASE_KEYS, 'release');

    if (release.python !== undefined) {
      if (typeof release.python !== 'string') {
        invalid('release.python', 'release.python must be a string');
      }

      if (release.python !== 'latest' && !TAG_PATTERN.test(release.python)) {
        invalid(
          'release.python',
          'release.python must be "latest" or an eight digit tag',
        );
      }

      config.release = { python: release.python };
    }
  }

  return config;
}

/** Fills the unspecified categories with the built-in official sources. */
export function resolveMirrorConfig(
  config: MirrorConfig = {},
): ResolvedMirrorConfig {
  return {
    uv: config.sources?.uv ?? DEFAULT_MIRRORS.uv,
    python: config.sources?.python ?? DEFAULT_MIRRORS.python,
    packages: config.sources?.packages ?? DEFAULT_MIRRORS.packages,
    pythonRelease: config.release?.python ?? DEFAULT_MIRRORS.pythonRelease,
  };
}

/**
 * The file the app writes on first run. It spells the built-in sources out so a
 * user staring at `mirrors.json` can see the shape the parser accepts; editing
 * a URL is the whole point of the file.
 */
export function mirrorConfigDocument(): string {
  return `${JSON.stringify(
    {
      sources: {
        uv: DEFAULT_MIRRORS.uv,
        python: DEFAULT_MIRRORS.python,
        packages: DEFAULT_MIRRORS.packages,
      },
      release: { python: DEFAULT_MIRRORS.pythonRelease },
    },
    null,
    2,
  )}\n`;
}

/** Reads `mirrors.json`; a missing file means "use the built-in sources". */
export async function loadMirrorConfig(
  path: string,
): Promise<ResolvedMirrorConfig> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_MIRRORS;
    }

    throw error;
  }

  return resolveMirrorConfig(parseMirrorConfig(text));
}

/** The app-wide user data directory, without importing electron. */
export function defaultUserDataDir(
  productName: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), productName);
  }

  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', productName);
  }

  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), productName);
}

export function mirrorConfigPath(userDataDir: string): string {
  return join(userDataDir, 'mirrors.json');
}
