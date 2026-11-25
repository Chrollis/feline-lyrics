import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { execa } from 'execa';
import { x } from 'tar';

import { ToolchainError } from '../errors.js';
import type { ResolvedMirrorConfig } from '../mirrors.js';
import { download } from './download.js';
import {
  PYTHON_SHORT_VERSION,
  SUPPORTED_TARGETS,
  type TargetKey,
} from './target.js';

/** GitHub's short redirect; one request names the newest pbs tag. */
export const PYTHON_LATEST_URL =
  'https://github.com/astral-sh/python-build-standalone/releases/latest';

/**
 * The platform part of a python-build-standalone asset name. Kept apart from
 * `TARGETS` because uv and pbs spell the same platform differently.
 */
export const PYTHON_TRIPLES: Readonly<Record<TargetKey, string>> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

/** A body below this is not a CPython install, even with the right name. */
export const MIN_PYTHON_BYTES = 1024 ** 2;

export interface PythonRelease {
  readonly tag: string;
  /** The full patch version, e.g. `3.12.16`. */
  readonly version: string;
  readonly asset: string;
  readonly url: string;
  /** Present when the page that listed the asset also published a digest. */
  readonly sha256?: string;
}

export interface ResolvePythonOptions {
  readonly config: ResolvedMirrorConfig;
  /** Defaults to the host platform; tests pass a row directly. */
  readonly targetKey?: TargetKey;
  /** `major.minor`; defaults to the series the toolchain targets today. */
  readonly series?: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  /** The URL that redirects to the newest release; a seam for tests. */
  readonly latestTagUrl?: string;
  /** Where `{url}` templates read the file listing; a seam for tests. */
  readonly listingBase?: string;
  /** Where `{url}` templates point at the official asset; a seam for tests. */
  readonly downloadBase?: string;
}

export interface EnsurePythonOptions extends ResolvePythonOptions {
  /** The directory that will hold `python/` after unpacking. */
  readonly destination: string;
  /** Downloads land under `<cacheDir>/downloads/python/`. */
  readonly cacheDir: string;
  readonly onProgress?: (received: number, total: number | null) => void;
  /** Replaces the `python -VV` check; a seam for tests. */
  readonly verify?: (pythonPath: string, version: string) => Promise<void>;
}

export interface InstalledPython {
  readonly release: PythonRelease;
  readonly pythonPath: string;
}

export interface ReleasePageAsset {
  readonly name: string;
  readonly sha256?: string;
}

function publicUrl(url: string): string {
  try {
    const parsed = new URL(url);

    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparsable url)';
  }
}

function isBrowserChallenge(error: unknown): error is ToolchainError {
  return error instanceof ToolchainError && error.code === 'download/browser-required';
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&#43;', '+')
    .replaceAll('%2B', '+')
    .replaceAll('%2b', '+');
}

function lastPathSegment(path: string): string {
  return decodeHtml(path.slice(path.lastIndexOf('/') + 1));
}

/** A dead proxy answers nothing at all; these ceiling the small page requests. */
const PAGE_TIMEOUT_MS = 15_000;

function pageSignal(signal: AbortSignal | undefined): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);

  controller.signal.addEventListener('abort', () => clearTimeout(timer), {
    once: true,
  });
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  return controller.signal;
}

/**
 * Reads a small HTML page and turns mirror blocks into a code a caller can act
 * on. USTC answers 403 with a browser challenge instead of 404, so a plain
 * `!ok` would look like a missing file and hide the one case worth reporting.
 */
async function readPage(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetchImpl(url, {
    signal: pageSignal(signal),
  });

  if (response.ok) {
    return response.text();
  }

  const body = await response.text().catch(() => '');

  if (
    response.status === 403 &&
    /verifying your browser|requires javascript/i.test(body)
  ) {
    throw new ToolchainError(
      'download/browser-required',
      `the source wants a browser check: ${publicUrl(url)}`,
      { url: publicUrl(url), status: response.status },
    );
  }

  throw new ToolchainError(
    'download/failed',
    `HTTP ${response.status} for ${publicUrl(url)}`,
    { url: publicUrl(url), status: response.status },
  );
}

/**
 * Turns a release page into asset names and digests.
 *
 * GitHub prints the digest next to the asset, but the markup is not a contract,
 * so this pairs them by the nearest following `sha256:` within the same list
 * item and simply omits the digest when the shape changes. A missing digest
 * weakens the check, it does not fail the install.
 */
export function parseReleasePage(html: string): ReleasePageAsset[] {
  const assets: ReleasePageAsset[] = [];
  const items = html.split(/<li\b/i).slice(1);

  for (const item of items) {
    const link = /\/download\/[^"/]+\/([^"/]+)"/i.exec(item);
    if (link === null) {
      continue;
    }

    const digest = /sha256:([0-9a-f]{64})/i.exec(item)?.[1]?.toLowerCase();
    assets.push({
      name: decodeHtml(link[1]!),
      ...(digest === undefined ? {} : { sha256: digest }),
    });
  }

  if (assets.length > 0) {
    return assets;
  }

  // A plain directory listing has links but no digests; keep the names so a
  // mirror that does not publish checksums can still serve the archive.
  for (const match of html.matchAll(/\/download\/[^"/]+\/([^"/]+)"/gi)) {
    assets.push({ name: decodeHtml(match[1]!) });
  }

  return assets;
}

/** The `.tar.gz` names a directory listing offers, without the directory. */
export function parseListing(html: string): string[] {
  const names = new Set<string>();

  for (const match of html.matchAll(/href="([^"]+\.tar\.gz)"/gi)) {
    names.add(lastPathSegment(match[1]!));
  }

  return [...names];
}

/** The eight digit tag directories a pbs mirror lists. */
export function parseTags(html: string): string[] {
  const tags = new Set<string>();

  for (const match of html.matchAll(/href="[^"]*?\/(\d{8})\/?"/gi)) {
    tags.add(match[1]!);
  }

  return [...tags].sort();
}

export interface SelectedAsset {
  readonly name: string;
  readonly version: string;
  readonly build: string;
  readonly stripped: boolean;
}

/**
 * Picks the newest patch of the wanted series for one platform, preferring the
 * stripped archive when both forms exist. Sorting by `stripped` after the
 * version keeps the smaller archive for a tie.
 */
export function selectPythonAsset(
  names: readonly string[],
  triple: string,
  series: string,
): SelectedAsset | null {
  const [major, minor] = series.split('.');
  const pattern = new RegExp(
    `^cpython-(\\d+)\\.(\\d+)\\.(\\d+)\\+(\\d{8})-${escapeRegex(
      triple,
    )}-install_only(?:_stripped)?\\.tar\\.gz$`,
  );

  const candidates: SelectedAsset[] = [];

  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) {
      continue;
    }
    if (match[1] !== major || match[2] !== minor) {
      continue;
    }

    candidates.push({
      name,
      version: `${match[1]}.${match[2]}.${match[3]}`,
      build: match[4]!,
      stripped: name.includes('-install_only_stripped.tar.gz'),
    });
  }

  candidates.sort((left, right) => {
    if (left.version !== right.version) {
      return left.version.localeCompare(right.version, 'en', {
        numeric: true,
      });
    }

    return Number(left.stripped) - Number(right.stripped);
  });

  return candidates.at(-1) ?? null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultTargetKey(): TargetKey {
  const key = `${process.platform}-${process.arch}`;

  if (!SUPPORTED_TARGETS.includes(key as TargetKey)) {
    throw new ToolchainError(
      'target/unsupported',
      `the toolchain has no python asset for ${key}`,
      { target: key },
    );
  }

  return key as TargetKey;
}

/** Where the official listing and assets live; `{url}` templates reuse them. */
const OFFICIAL_LISTING = 'https://github.com/astral-sh/python-build-standalone/releases/expanded_assets';
const OFFICIAL_DOWNLOAD = 'https://github.com/astral-sh/python-build-standalone/releases/download';

/**
 * Where to read the tag list from a source. GitHub's download URL has a
 * sibling `expanded_assets` page with names and digests; a mirror keeps the
 * same prefix and lists tags as directories; a `{url}` proxy does not list
 * files at all, so the official page is read and only the download is proxied.
 */
function listingUrl(template: string, tag: string, listingBase = OFFICIAL_LISTING): string {
  if (template.includes('{url}')) {
    return `${listingBase}/${tag}`;
  }

  const prefix = template.slice(0, template.indexOf('{tag}'));

  if (prefix.endsWith('/releases/download/')) {
    return `${prefix.slice(0, -'download/'.length)}expanded_assets/${tag}`;
  }

  return `${prefix}${tag}/`;
}

async function resolveTag(
  config: ResolvedMirrorConfig,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  latestTagUrl: string,
): Promise<string> {
  if (config.pythonRelease !== 'latest') {
    return config.pythonRelease;
  }

  let challenge: ToolchainError | undefined;
  const tagLink = /\/releases\/tag\/(\d{8})/;

  // The redirect is a single small request, but github.com occasionally drops
  // it or answers 429; retrying here is cheaper than making the user pin a tag.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(latestTagUrl, {
        redirect: 'manual',
        signal: pageSignal(signal),
      });
      const location = response.headers.get('location') ?? '';
      const tag = tagLink.exec(location)?.[1];

      if (tag !== undefined) {
        return tag;
      }

      if (response.ok) {
        const body = await response.text();
        const fromBody = tagLink.exec(body)?.[1];

        if (fromBody !== undefined) {
          return fromBody;
        }
      }
    } catch (error) {
      if (isBrowserChallenge(error)) {
        challenge = error;
      }
    }

    if (attempt < 2) {
      await delay(attempt === 0 ? 500 : 1500);
    }
  }

  // Last chance: the releases page itself. It is large, but it is one HTML
  // request and it names the newest tag the same way.
  try {
    const page = await readPage(
      latestTagUrl.replace(/\/latest$/, ''),
      fetchImpl,
      signal,
    );
    const tag = tagLink.exec(page)?.[1];

    if (tag !== undefined) {
      return tag;
    }
  } catch (error) {
    if (isBrowserChallenge(error)) {
      challenge = error;
    }
  }

  for (const template of config.python) {
    const at = template.indexOf('{tag}');

    if (at < 0) {
      // A `{url}` proxy cannot list tags either; the caller's latest redirect
      // is the only way to learn one.
      continue;
    }

    const prefix = template.slice(0, at);
    if (prefix.length === 0) {
      continue;
    }

    try {
      const page = await readPage(prefix, fetchImpl, signal);
      const tags = parseTags(page);

      if (tags.length > 0) {
        return tags.at(-1)!;
      }
    } catch (error) {
      if (isBrowserChallenge(error)) {
        challenge = error;
      }
    }
  }

  if (challenge !== undefined) {
    throw challenge;
  }

  throw new ToolchainError(
    'download/failed',
    'cannot resolve the latest python release tag',
    { url: publicUrl(latestTagUrl) },
  );
}

/**
 * Names the archive and where to get it, without downloading anything.
 *
 * Sources are tried in order; the first one that lists a matching archive wins,
 * so a reachable mirror is used before an unreachable official host.
 */
export async function resolvePythonRelease(
  options: ResolvePythonOptions,
): Promise<PythonRelease> {
  const key = options.targetKey ?? defaultTargetKey();
  const triple = PYTHON_TRIPLES[key];
  const series = options.series ?? PYTHON_SHORT_VERSION;
  const fetchImpl = options.fetchImpl ?? fetch;
  const tag = await resolveTag(
    options.config,
    fetchImpl,
    options.signal,
    options.latestTagUrl ?? PYTHON_LATEST_URL,
  );

  let challenge: ToolchainError | undefined;

  for (const template of options.config.python) {
    let page: string;

    try {
      page = await readPage(
        listingUrl(template, tag, options.listingBase),
        fetchImpl,
        options.signal,
      );
    } catch (error) {
      if (isBrowserChallenge(error)) {
        challenge = error;
      }
      continue;
    }

    const listed: ReleasePageAsset[] =
      template.includes('/releases/download/') || template.includes('{url}')
        ? parseReleasePage(page)
        : parseListing(page).map((name) => ({ name }));
    const selected = selectPythonAsset(
      listed.map((asset) => asset.name),
      triple,
      series,
    );

    if (selected === null) {
      continue;
    }

    const digest = listed.find((asset) => asset.name === selected.name)?.sha256;

    return {
      tag,
      version: selected.version,
      asset: selected.name,
      url: template.includes('{url}')
        ? template.replaceAll(
            '{url}',
            `${options.downloadBase ?? OFFICIAL_DOWNLOAD}/${tag}/${selected.name}`,
          )
        : template
            .replace('{tag}', tag)
            .replace('{asset}', selected.name),
      ...(digest === undefined ? {} : { sha256: digest }),
    };
  }

  if (challenge !== undefined) {
    throw challenge;
  }

  throw new ToolchainError(
    'python/unsupported',
    `no python ${series} archive for ${triple}`,
    { target: key },
  );
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));

  return hash.digest('hex');
}

async function reusableArchive(
  path: string,
  sha256: string | undefined,
): Promise<boolean> {
  let size: number;

  try {
    size = (await stat(path)).size;
  } catch {
    return false;
  }

  if (size < MIN_PYTHON_BYTES) {
    return false;
  }

  if (sha256 === undefined) {
    return true;
  }

  return (await hashFile(path)) === sha256;
}

/**
 * Unpacks the archive with node-tar, which understands gzip, ustar prefixes,
 * GNU long names and pax headers without asking the machine for a `tar`.
 * The archive is a published release, so this does not re-police entries; it
 * only refuses a failed unpack.
 *
 * The archive always holds one top-level `python/` directory, but the
 * destination also holds `uv/`; wiping the destination root would delete the
 * binary that the next step is about to run. Only `python/` is replaced, and
 * it is unpacked elsewhere first so a failed unpack leaves the old tree alone.
 */
async function unpack(archive: string, destination: string): Promise<void> {
  const staging = `${destination}.unpack`;

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    await x({ file: archive, cwd: staging, strict: true });
  } catch (error) {
    throw new ToolchainError(
      'archive/unusable',
      'tar could not unpack the python archive',
      {
        archive: basename(archive),
        reason: String(error).slice(0, 200),
      },
      { cause: error },
    );
  }

  const unpacked = join(staging, 'python');

  if (!existsSync(unpacked)) {
    throw new ToolchainError(
      'archive/unusable',
      'the python archive does not contain a python/ directory',
      { archive: basename(archive) },
    );
  }

  await mkdir(destination, { recursive: true });
  await rm(join(destination, 'python'), { recursive: true, force: true });

  try {
    await rename(unpacked, join(destination, 'python'));
  } catch (error) {
    const { readdir } = await import('node:fs/promises');
    throw new ToolchainError(
      'archive/unusable',
      `cannot move the unpacked python into place (${(await readdir(staging)).join(', ')}; ${String(error).slice(0, 160)})`,
      { archive: basename(archive), reason: String(error).slice(0, 200) },
      { cause: error },
    );
  }

  await rm(staging, { recursive: true, force: true });
}

function pythonPath(destination: string, key: TargetKey): string {
  return key.startsWith('win32')
    ? join(destination, 'python', 'python.exe')
    : join(destination, 'python', 'bin', 'python3');
}

async function defaultVerify(pythonPathValue: string, version: string): Promise<void> {
  const result = await execa(pythonPathValue, ['-VV'], { reject: false });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const found = /Python (\d+\.\d+\.\d+)/.exec(output)?.[1];

  if (result.exitCode !== 0 || found !== version) {
    throw new ToolchainError(
      'python/version-mismatch',
      `the unpacked python reported ${found ?? 'nothing'}, expected ${version}`,
      { command: pythonPathValue, reason: output.trim().slice(0, 200) },
    );
  }
}

/**
 * Resolves, downloads, verifies, unpacks and checks a CPython build.
 *
 * The archive is cached by tag, so a retry after a failed unpack does not pay
 * for the 22 MB again. A missing checksum degrades to "the archive has a
 * plausible size", because a mirror that lists files rarely lists digests.
 */
export async function ensurePython(
  options: EnsurePythonOptions,
): Promise<InstalledPython> {
  const key = options.targetKey ?? defaultTargetKey();
  const release = await resolvePythonRelease(options);
  const archive = join(
    options.cacheDir,
    'downloads',
    'python',
    release.tag,
    release.asset,
  );

  await mkdir(dirname(archive), { recursive: true });

  if (!(await reusableArchive(archive, release.sha256))) {
    await download({
      url: release.url,
      dest: archive,
      minBytes: MIN_PYTHON_BYTES,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined
        ? {}
        : { onProgress: options.onProgress }),
    });

    if (release.sha256 !== undefined) {
      const actual = await hashFile(archive);

      if (actual !== release.sha256) {
        await rm(archive, { force: true }).catch(() => {});
        throw new ToolchainError(
          'python/checksum-failed',
          `the python archive does not match its published sha256`,
          {
            url: publicUrl(release.url),
            reason: `expected ${release.sha256}, got ${actual}`,
          },
        );
      }
    }
  }

  await unpack(archive, options.destination);

  const python = pythonPath(options.destination, key);
  const verify = options.verify ?? defaultVerify;
  await verify(python, release.version);

  return { release, pythonPath: python };
}
