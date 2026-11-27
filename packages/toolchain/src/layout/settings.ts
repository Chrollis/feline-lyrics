import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { ToolchainError } from '../errors.js';

/**
 * The user's writable roots, as written in `settings.json`. Every field is
 * optional: an omitted field keeps the built-in default for the build kind.
 */
export interface Settings {
  /** Where the Python backend, uv and the venv live. */
  readonly backendRoot?: string;
  /** Downloaded archives and job output, shared by the whole application. */
  readonly cacheDir?: string;
  /** Scratch space for one operation; cleared at startup. */
  readonly tempDir?: string;
  /** Where the user installs plugins; a scan root, not a venv location. */
  readonly userPluginsRoot?: string;
}

/** What decides the default roots and the file's location. */
export interface SettingsInputs {
  readonly packaged: boolean;
  /** The application's user data directory. */
  readonly userData: string;
  /** The checkout root in development; the file lives there. */
  readonly repoRoot: string;
}

const DOCUMENT = 'settings.json';
const SETTING_KEYS = new Set([
  'backendRoot',
  'cacheDir',
  'tempDir',
  'userPluginsRoot',
]);

function invalid(key: string | undefined, message: string): never {
  throw new ToolchainError('settings/invalid', message, {
    path: key === undefined ? DOCUMENT : `${DOCUMENT}.${key}`,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function absolutePath(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(key, `${key} must be a non-empty string`);
  }

  if (!isAbsolute(value)) {
    invalid(key, `${key} must be an absolute path`);
  }

  return value;
}

/**
 * Packaged builds keep settings beside the other user data; development reads
 * the checkout file so the app and the CLI share one file.
 */
export function resolveSettingsPath(inputs: SettingsInputs): string {
  const root = inputs.packaged ? inputs.userData : inputs.repoRoot;

  return join(resolve(root), DOCUMENT);
}

/**
 * The four defaults for one build kind. `userPluginsRoot` stays under userData
 * in development too: plugins are user state, not checkout state.
 */
export function defaultSettings(inputs: SettingsInputs): Required<Settings> {
  const userData = resolve(inputs.userData);
  const repoRoot = resolve(inputs.repoRoot);

  if (inputs.packaged) {
    return {
      backendRoot: join(userData, 'backend'),
      cacheDir: join(userData, 'cache'),
      tempDir: join(userData, 'temp'),
      userPluginsRoot: join(userData, 'plugins'),
    };
  }

  return {
    backendRoot: join(repoRoot, 'python'),
    cacheDir: join(repoRoot, 'cache'),
    tempDir: join(repoRoot, '.temp'),
    userPluginsRoot: join(userData, 'plugins'),
  };
}

/**
 * Reads `settings.json`. A missing file means "all defaults"; a present file is
 * validated strictly, because a typo that silently fell back would write state
 * somewhere the user did not choose.
 */
export async function loadSettings(path: string): Promise<Settings> {
  let text: string;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    throw error;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    invalid(undefined, `${DOCUMENT} is not valid JSON: ${String(error)}`);
  }

  if (!isObject(parsed)) {
    invalid(undefined, `${DOCUMENT} must be an object`);
  }

  for (const key of Object.keys(parsed)) {
    if (!SETTING_KEYS.has(key)) {
      invalid(key, `unknown key ${key} in ${DOCUMENT}`);
    }
  }

  const settings: {
    backendRoot?: string;
    cacheDir?: string;
    tempDir?: string;
    userPluginsRoot?: string;
  } = {};

  if (parsed.backendRoot !== undefined) {
    settings.backendRoot = absolutePath(parsed.backendRoot, 'backendRoot');
  }

  if (parsed.cacheDir !== undefined) {
    settings.cacheDir = absolutePath(parsed.cacheDir, 'cacheDir');
  }

  if (parsed.tempDir !== undefined) {
    settings.tempDir = absolutePath(parsed.tempDir, 'tempDir');
  }

  if (parsed.userPluginsRoot !== undefined) {
    settings.userPluginsRoot = absolutePath(
      parsed.userPluginsRoot,
      'userPluginsRoot',
    );
  }

  return settings;
}
