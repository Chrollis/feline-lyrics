# Memory

Working notes for whoever picks this up next: human or agent. This is not a
design document. Code describes what exists and `git log` describes what
changed; this file records only what neither of them can tell you -- the
reasons, the dead ends, and what comes next.

Rules:

- One screen per section. When a section grows, delete stale lines instead of
  appending new ones.
- Write the reason, not the conclusion. "Chose X because Y" survives; "X"
  alone does not.
- Date the entries that can go stale, and delete them when they do.
- No code blocks longer than three lines. The code is in the code.

## State

- Electron shell runs. `npm run dev` opens a 960x640 window that shows
  `preload says: pong`, fetched over IPC (`ipcMain.handle('ping')`).
- The main process is ESM (`"type": "module"`); the preload is CJS
  (`index.cjs`), because a sandboxed preload cannot be ESM.
- `packages/toolchain` holds provisioning only, grouped by domain: `layout/`
  (paths, env), `process/` (zip), `python/` (target, download, ready, uv). The
  Python backend, its stdio protocol and ffmpeg are not written yet.
- `process/zip.ts` reads the central directory first, rejects any name that
  could escape the destination, and only then lets node-stream-zip write.
- `python/ready.ts` answers one question: did a full provisioning run finish and
  is the result untouched? It compares the `.ready` JSON marker and the two
  files underneath it; the marker is written last, so a partial run is never
  ready.
- `python/uv.ts` is the only place that runs uv: download the zip from the
  cached copy, unpack `uv.exe`, install the pinned interpreter, rebuild the
  venv, install packages. 54 tests pass.
- Paths are inputs: the toolchain takes `{ cacheDir, servicesDir, backendRoot }`
  from the caller and derives the rest, so the CLI and the app can disagree
  about where things live without the library knowing.

## Decisions

- Portable Python (python-build-standalone) instead of the system Python: a
  fresh machine needs no prerequisites, and the version is pinned by us.
- The Python backend is one long-lived process speaking JSON lines on stdio.
  Not a web socket, not one process per call.
- Plugin-declared dependencies: a feature asks for packages and the toolchain
  installs them. No feature assumes a preinstalled environment.
- Directory roles are lifecycle, not taste: `python/` is an artifact,
  `cache/` is reusable input, scratch work goes to the OS temp directory.
- Sources are grouped by domain, not by layer, so a helper shared by two tools
  (tar) has one obvious home instead of an "utils" drawer.
- Failures we expect and branch on carry a `ToolchainError` code
  (`domain/reason`) and structured `context`; unexpected ones (spawn ENOENT,
  killed process) stay native, so "the archive is at fault" is a code prefix,
  not a class.
- 2026-11 av no longer needs an lgpl FFmpeg: the backend is not shipped with
  the app, so a GPL build is fine and `pip install av` replaces the planned
  lgpl shared build plus `pip wheel av --ffmpeg-dir`.
- 2026-11 uv replaces the pbs download and the probe ladder: uv fetches its own
  python-build-standalone build, so PATH / conda / venv detection disappears.
  uv itself is downloaded with the app, not bundled.
- 2026-11 tar is gone in favour of node-stream-zip: a system tar is not
  guaranteed to read a zip, and a JS library keeps one code path on every
  platform. The name check stays ours, so every refusal shares one code.
- 2026-11 execa runs long commands (`uv python install` takes minutes) so the
  Electron main process never blocks. The long-lived Python service will still
  use `child_process.spawn`, which is what an interactive stdio session needs.
- 2026-11 uv 0.13.8's frozen list does include CPython 3.12.15: installing it
  through the USTC mirror took about 80 seconds for 21 MB. uv and the Python
  builds come from the USTC mirror, packages from Tsinghua. Pass
  `--no-bin --no-registry` to `uv python install` so it never writes to
  `~/.local/bin` or the Windows registry.
- 2026-11 the uv assets are a per-platform table, not one constant: uv ships a
  different file per OS and arch, and only the zip form is unpacked today, so
  `TARGETS` lists all six rows while `SUPPORTED_TARGETS` stays `win32-x64`.
- 2026-11 readiness is a marker, not an existence check: files can exist in a
  half-finished state, and a version can change under an existing directory.
  Comparing the marker's `uv`, `python` and absolute `services` is the cheap
  question; whether the interpreter actually runs is `--doctor`'s job.
- 2026-11 uv runs with an injected environment, never the inherited one: every
  `UV_*` and `PIP_*` variable is dropped first, so a machine with its own uv
  0.11 (this one has it in PATH) cannot pick the interpreter or the index. The
  backend's own `uv.exe` is the only uv the toolchain calls.

## Dead ends

- 2026-11 Electron exited at startup with `0x80000003` and printed nothing.
  The cause was the workspace directory carrying a Low integrity label, not
  the Electron version. Check with `icacls <dir> | findstr Mandatory`.
- 2026-11 `npm install` failed in the sandbox with EPERM writing the default
  npm cache under AppData; passing `--cache` inside the temp directory fixed it.
- 2026-11 The stall-timeout test hung forever. The fake fetch ignored the abort
  signal, so the read never rejected. Lesson: a timeout must reject on its own
  rather than trust the callee to honour it.
- 2026-11 `.prettierignore` patterns follow gitignore rules: `python/` also
  matches `packages/toolchain/src/python/`, so those sources went unformatted
  for weeks. A pattern for a repo-root directory needs the leading `/`.
- 2026-11 "generated asynchronous activity after the test ended" in `node:test`
  always means the same thing: an async function was called and its promise was
  dropped. The test was already marked done, then the late rejection surfaced
  against the whole file. Track down the missing `await`, do not retry the test.
- 2026-11 On Windows, spawning a missing executable does NOT reject with
  `ENOENT`, even with execa: it resolves with `failed: true` and `exitCode: 1`,
  because the OS loader runs and fails. Detect it by checking the file exists
  before spawning; do not wait for `exitCode === undefined`.
- 2026-11 stdout chunks are bytes, not characters: `chunk.toString()` turns one
  UTF-8 character split across two chunks into two U+FFFD. Decode with
  `StringDecoder` (or `TextDecoder` with `{ stream: true }`) and flush at the
  end. A test that writes a character in two `write()` calls catches it.

## Next

- Next: `provision()` -- download uv, install the interpreter, rebuild the venv,
  write the `.pth` with the absolute `servicesDir`, install the declared
  packages, then write the marker last.
- Then `scripts/python.mjs`: `--setup`, `--doctor`, and argument passthrough.