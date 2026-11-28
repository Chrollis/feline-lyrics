import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep, win32 } from 'node:path';

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

/**
 * A root such as `C:\` or `\\server\share`, or a Windows root-relative path
 * such as `\foo` or `/foo`, names a location the user did not choose. All four
 * settings are writable roots, so accepting one of those forms would let a typo
 * point provisioning or cleanup at an entire volume or share.
 */
function isFilesystemRoot(value: string): boolean {
  if (process.platform !== 'win32') {
    return resolve(value) === '/';
  }

  const normalized = win32.normalize(value);

  if (normalized === win32.parse(normalized).root) {
    return true;
  }

  // `\foo` and `/foo` are absolute on Windows but relative to the current
  // drive; a drive path or a UNC path always starts with a drive or `\\`.
  return /^\\[^\\]/.test(normalized);
}

function absolutePath(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(key, `${key} must be a non-empty string`);
  }

  if (!isAbsolute(value)) {
    invalid(key, `${key} must be an absolute path`);
  }

  if (isFilesystemRoot(value)) {
    invalid(key, `${key} must not be a filesystem root or a root-relative path`);
  }

  return value;
}

/**
 * True when `parent` is the same directory as `child` or one of its ancestors.
 * Windows compares case-insensitively and both sides are resolved, so `C:\Temp`
 * and `c:\temp\jobs` overlap.
 */
function containsPath(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const fold = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  const parentPath = fold(resolvedParent);
  const childPath = fold(resolvedChild);

  if (parentPath === childPath) {
    return true;
  }

  return childPath.startsWith(
    parentPath.endsWith(sep) ? parentPath : `${parentPath}${sep}`,
  );
}

/**
 * A tempDir that is an existing file cannot be a scratch directory. ENOENT is
 * fine because the directory is created at startup; every other stat failure is
 * a settings problem too, not leftover state to ignore.
 */
function assertTempDirectory(path: string): void {
  let stats;

  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    invalid(
      'tempDir',
      `tempDir cannot be inspected: ${resolve(path)}: ${String(error)}`,
    );
  }

  if (!stats.isDirectory()) {
    invalid('tempDir', `tempDir must be a directory: ${resolve(path)}`);
  }
}

/**
 * The settings are individually valid but can still overlap. A temp root that
 * contains the backend, the cache, the plugin storage, the logs, the settings
 * file itself or the whole userData directory would clear data it does not own.
 * It must also not sit inside a managed root: clearing it on startup would
 * delete that root's contents. The reverse is fine only for userData and the
 * repository -- the dev `.temp` under the repo and the packaged `temp` under
 * userData are both intended, and neither is a managed root.
 */
export function assertWritableRoots(
  merged: Required<Settings>,
  settingsPath: string,
  userData: string,
): void {
  const managedTargets: ReadonlyArray<readonly [string, string]> = [
    ['backendRoot', merged.backendRoot],
    ['cacheDir', merged.cacheDir],
    ['userPluginsRoot', merged.userPluginsRoot],
    ['the logs directory', join(resolve(userData), 'logs')],
  ];

  for (const [label, target] of managedTargets) {
    if (
      containsPath(merged.tempDir, target) ||
      containsPath(target, merged.tempDir)
    ) {
      invalid(
        'tempDir',
        `tempDir must not overlap ${label}: ${resolve(target)}`,
      );
    }
  }

  const containers: ReadonlyArray<readonly [string, string]> = [
    ['the settings file', settingsPath],
    ['userData', userData],
  ];

  for (const [label, target] of containers) {
    if (containsPath(merged.tempDir, target)) {
      invalid(
        'tempDir',
        `tempDir must not be the same as or contain ${label}: ${resolve(target)}`,
      );
    }
  }

  assertTempDirectory(merged.tempDir);
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

  // Notepad and PowerShell both like a UTF-8 BOM; JSON.parse does not. Strip one
  // leading marker, the same way mirror-config.ts reads its file.
  const body = text.replace(/^\uFEFF/, '');

  try {
    parsed = JSON.parse(body);
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
