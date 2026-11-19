# Reference

Everything exported from `@felyrics/toolchain` (`src/index.ts`), the files it owns on
disk, and the codes it throws. Names and signatures are authoritative; this page exists
so a reader does not have to open every module.

## Entry points

| Function | Signature | Effect |
| --- | --- | --- |
| `provision` | `(options: ProvisionOptions) => Promise<ReadyMarker>` | Builds or rebuilds the backend; writes the marker last |
| `doctor` | `(toolchain: ToolchainPaths, options?: DoctorOptions) => Promise<DoctorReport>` | Read-only health check; runs binaries, reads `.pth` and marker |
| `startService` | `(options: ServiceOptions) => ServiceClient` | Spawns the backend and speaks its line protocol |
| `download` | `(options: DownloadOptions) => Promise<number>` | Streams one file to `dest`; resolves with the byte count |
| `withTempDir` | `<T>(prefix: string, fn: (dir: string) => Promise<T>) => Promise<T>` | Creates a scratch directory and removes it in `finally` |

`DownloadOptions`:

| Option | Meaning |
| --- | --- |
| `url`, `dest` | Where the bytes come from and the final path (a `.part` file is renamed onto it) |
| `minBytes` | Required floor for a body that arrives without `content-length` |
| `attempts` | Total attempts, default 3; must be at least 1 |
| `idleMs` | Abort when no bytes arrive for this long, default 30 000; `0` disables it |
| `retryDelay` | Backoff before the next attempt, given the failed attempt |
| `onProgress` | `(received, total \| null)` |
| `removePartial` | Replaces the cleanup of the `.part` file; a test seam |
| `signal` | Cancels, including a stream already in flight; never retried |

## Layout

| Type | Fields |
| --- | --- |
| `ToolchainPaths` | `cacheDir`, `servicesDir`, `backendRoot` |
| `CachePaths` | `downloads`, `uv`, `wheels` |
| `BackendPaths` | `root`, `uvExe`, `pythonDir`, `venvDir`, `venvPython`, `sitePackages`, `readyMarker` |
| `PlatformTarget` | `uvFilename`, `archive`, `uvExeName`, `venvBinDir`, `venvPythonName`, `sitePackages` |

| Function | Returns |
| --- | --- |
| `cachePaths(cacheDir)` | `CachePaths` under the given root |
| `backendPaths(backendRoot, target?)` | `BackendPaths`; `target` defaults to `currentTarget()` |
| `buildEnv(dirs, base?)` | Environment for pip: inherited vars minus `PIP_*`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONUSERBASE`, `VIRTUAL_ENV`, plus no-user-site, cache and temp |
| `buildUvEnv(dirs, base?)` | Environment for uv: the same, minus `UV_*` as well, plus its own cache, install dir, mirror, build pin, preference, no-config and index (every variable is listed in [provisioning.md](provisioning.md#environment)) |

## Python provisioning

| Function | Returns |
| --- | --- |
| `downloadUv(ctx, target, options?)` | Path to `uv.exe`; reuses the cached archive, heals a damaged one once |
| `installPython(ctx, mirrors?)` | `void`; tries each mirror in order, throws the last failure |
| `createVenv(ctx)` | `void`; `uv venv --clear`, so the venv is always rebuilt |
| `installPackages(ctx, requirements)` | `void`; no-op on an empty list |
| `uvEnv(ctx, installMirror?)` | The environment for one uv command |
| `uvArchivePath(cacheDir, target)` | Where the uv archive is cached |
| `runUv(uvExe, args, options)` | `UvResult`; the default runner, exported for tests |
| `writePth(toolchain, backend)` | Path of the written `.pth` |
| `readRequirements(servicesDir)` | Non-empty, non-comment lines of `services/requirements.txt` |
| `requirementModule(requirement)` | The import name a requirement implies |
| `requirementsFingerprint(requirements)` | The string stored in the marker |
| `isReady(backend, expected)` | `boolean`; marker matches **and** both binaries exist |
| `readReadyMarker(backend)` | `ReadyMarker \| null`; a missing or broken file is `null` |
| `markerMatches(marker, expected)` | `boolean` |
| `writeReadyMarker(backend, marker)` | `void` |

## Protocol client

| Name | Meaning |
| --- | --- |
| `startService(options)` | One long-lived process; returns `{ request, close }` |
| `PROTOCOL_VERSION` | The envelope version this client speaks |
| `DEFAULT_REQUEST_TIMEOUT_MS` | 30 000; applied when a request names no deadline |
| `BackendError` | A failure the backend reported; `code` preserved as a field |
| `ServiceMessage` | One parsed line: `v`, `id`, `result`, `error` |

## Constants

| Constant | Value |
| --- | --- |
| `UV_VERSION` | `0.13.8` |
| `PYTHON_VERSION` | `3.12.15` |
| `PYTHON_SHORT_VERSION` | `3.12` — the form venv directories use |
| `PYTHON_BUILD` | `20261021` — the CPython build uv resolves to |
| `PYTHON_VERSION_SLOT` | `{python}` placeholder inside `sitePackages` parts |
| `UV_DOWNLOAD_BASE` | USTC mirror for uv releases |
| `PYTHON_INSTALL_MIRRORS` | USTC first, GitHub releases second — order is the fallback order |
| `PACKAGE_INDEX_URL` | Tsinghua PyPI index |
| `MIN_DOWNLOAD_BYTES` | 1 MiB floor for an archive |
| `SUPPORTED_TARGETS` | `['win32-x64']` |
| `REQUIREMENTS_FILENAME` | `requirements.txt` |
| `PTH_FILENAME` | `felyrics.pth` |

## On-disk layout

```
<cacheDir>/
  downloads/uv/<uv version>/<uv archive>
  uv/                       # uv's own package cache
  wheels/                   # reserved
  jobs/<kind>/<uuid>/<file> # backend results: audio.flac, 0001.png, ...

<backendRoot>/
  uv/uv.exe
  python/cpython-<version>-<platform>-none/   # owned by uv, deleted as a whole
  venv/Scripts/python.exe
  venv/Lib/site-packages/felyrics.pth
  .ready
```

## Error codes

`ToolchainError` carries a `code` from this closed list plus a typed `context`. Failures
the toolchain does not expect (a spawn error, an unreadable disk) stay native errors.

| Code | Raised when |
| --- | --- |
| `archive/unusable` | The zip cannot be read or unpacked |
| `archive/unsafe-entry` | An entry name is absolute, traverses upwards, or names a drive |
| `target/unsupported` | No platform row, or the row's archive form cannot be unpacked |
| `download/cancelled` | The caller's `AbortSignal` fired |
| `download/failed` | Network failure, bad status, truncated body, empty body, stalled stream |
| `backend/not-provisioned` | The app tried to use a backend that was never provisioned |
| `backend/unavailable` | The process failed to start, died, or its stdin closed |
| `backend/timeout` | No answer within the deadline |
| `backend/protocol` | A line that cannot be routed, or an error object without `code`/`message` |
| `backend/version-mismatch` | Either side declared another envelope version |
| `uv/missing-binary` | The unpacked uv archive does not contain the executable |
| `uv/install-failed` | `uv python install` failed against every mirror |
| `uv/venv-failed` | `uv venv` failed |
| `uv/packages-failed` | `uv pip install` failed |

## CLI

`npm run python -- <args>` runs `scripts/python.mjs`.

| Argument | Effect |
| --- | --- |
| `--setup` | `provision()` with the repository layout; prints `ready: uv …, python …` |
| `--doctor` | `doctor()`; prints `ok`/`fail` per check, exits non-zero when unhealthy |
| anything else | Forwarded verbatim to `python/venv/Scripts/python.exe` |

Both paths need `packages/toolchain/out`; without it the CLI prints
`the toolchain is not built; run: npm run build -w @felyrics/toolchain`.
