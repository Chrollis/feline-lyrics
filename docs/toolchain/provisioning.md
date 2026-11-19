# Provisioning

How one `provision()` run gets a backend from nothing to usable, why the steps are in
this order, and what a second run reuses. See [reference.md](reference.md) for
signatures.

## Sequence

```
isReady(marker)?  ── yes ──> return (unless force)
      │ no
      ├─ delete .ready              marker stops claiming the tree is usable
      ├─ downloadUv()               cached archive -> uv.exe
      ├─ installPython()            uv python install 3.12.15 --no-bin --no-registry
      ├─ createVenv()               uv venv <venv> --python 3.12.15 --clear
      ├─ writePth()                 absolute servicesDir into the venv's site-packages
      ├─ installPackages()          uv pip install --python <venv python> <requirements>
      └─ writeReadyMarker()         the commit point
```

### Why this order

| Decision | Reason |
| --- | --- |
| The marker is written last | It is the commit point of a run. A killed run leaves half-finished directories that `isReady()` reports as not ready, so the next run rebuilds. |
| A rebuild deletes the marker first | `uv venv --clear` empties the venv at an early step. If the marker were only overwritten on success, a crash after that step would leave the old marker beside a broken interpreter, and `isReady()` only checks that files exist. |
| Nothing else is cleaned up on failure | `cacheDir` is reusable input; deleting it only makes the next attempt download the same bytes again. `--clear` (venv) and per-version download paths (archives) overwrite the half-finished parts. |

## What a second run reuses

| Step | Reused when |
| --- | --- |
| uv archive | `cacheDir/downloads/uv/<uv version>/<file>` exists and is at least 1 MiB |
| `uv.exe` | The file exists; unpacking a running executable fails on Windows |
| CPython | uv decides; the interpreter lives in `backendRoot/python/cpython-…-none/` |
| venv | Never — it is rebuilt every run, because the configuration is an invariant |
| Requirements | An empty list is a no-op; otherwise uv skips what is already satisfied |

`backendRoot/python/` belongs to uv. It writes `.lock`, `.temp/` and `.gitignore` there
and may add further version directories; the toolchain treats it as a directory to
delete as a whole and never writes its own files into it.

## Environment

uv and pip never inherit the caller's configuration. `buildUvEnv()` drops every
`UV_*`, `PIP_*`, `PYTHONPATH`, `PYTHONHOME`, `PYTHONUSERBASE` and `VIRTUAL_ENV`, then
sets:

| Variable | Value | Effect |
| --- | --- | --- |
| `UV_NO_CONFIG` | `1` | Ignore any user `uv.toml` |
| `UV_PYTHON_INSTALL_DIR` | `backendRoot/python` | Interpreters stay inside the backend |
| `UV_PYTHON_INSTALL_MIRROR` | one mirror, tried in order | Where the interpreter comes from |
| `UV_PYTHON_CPYTHON_BUILD` | `PYTHON_BUILD` | Pin the exact build |
| `UV_PYTHON_PREFERENCE` | `only-managed` | Never fall back to a system Python |
| `UV_PYTHON_DOWNLOADS` | `manual` | uv must not download an interpreter on its own |
| `UV_DEFAULT_INDEX` | `PACKAGE_INDEX_URL` | Package index |
| `TEMP`, `TMP`, `TMPDIR` | the caller's `tempDir` | One scratch directory regardless of platform |

The reason is concrete: the `uv` on `PATH` may be another version, and a user's own
`UV_*` variables may point the interpreter or the index elsewhere. Provisioning always
runs `backendPaths().uvExe`.

`tempDir` is the caller's scratch directory: the caller creates it and removes it in
`finally` (`withTempDir()` does exactly that). The toolchain only passes the path on.

## Mirrors and pins

uv is downloaded from `UV_DOWNLOAD_BASE` as `<base>/<version>/<filename>`. The Python
interpreter comes from `PYTHON_INSTALL_MIRRORS`, which is ordered: a mirror proxies
GitHub releases on demand, so a tag it has not cached yet fails, and the next entry
takes over. `installPython()` retries across that list and throws the last failure.

Both the interpreter version and its CPython build are pinned. uv's downloadable list is
frozen per uv release, so a different build appears only with a uv upgrade.

## The `.pth` file and the requirements fingerprint

`writePth()` writes one absolute line — the resolved `servicesDir` — into the venv's
site-packages. A relative path would follow the working directory, and the backend would
stop importing as soon as it was started from elsewhere.

The marker stores `requirementsFingerprint()`, which is the requirement lines joined
with newlines. It is a **cache key**: it records that this venv was built from exactly
these bytes. Editing the file — including reordering it — invalidates the marker and
triggers a rebuild. That asymmetry is deliberate: a false positive costs a rebuild of a
few seconds with warm caches, while a false negative leaves a venv that silently differs
from the file while `--doctor` still reports the dependencies as fine.

## Verification

```bash
npm run python -- --doctor
```

Six checks, no writes:

| Check | Passes when |
| --- | --- |
| `uv` | `uv --version` reports `UV_VERSION` |
| `python` | The venv interpreter reports `PYTHON_VERSION` |
| `dependencies` | The venv interpreter can import every declared requirement |
| `pth` | `felyrics.pth` mentions the current `servicesDir` |
| `import` | `python -c "import felyrics.__main__"` succeeds |
| `marker` | `.ready` matches the current expectations exactly |
