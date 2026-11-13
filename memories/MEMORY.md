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
  (paths, env), `process/` (zip), `python/` (target, download). The Python
  backend, its stdio protocol and ffmpeg are not written yet.
- `process/zip.ts` reads the central directory first, rejects any name that
  could escape the destination, and only then lets node-stream-zip write.
  27 tests pass.
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

## Dead ends

- 2026-11 Electron exited at startup with `0x80000003` and printed nothing.
  The cause was the workspace directory carrying a Low integrity label, not
  the Electron version. Check with `icacls <dir> | findstr Mandatory`.
- 2026-11 `npm install` failed in the sandbox with EPERM writing the default
  npm cache under AppData; passing `--cache` inside the temp directory fixed it.
- 2026-11 The stall-timeout test hung forever. The fake fetch ignored the abort
  signal, so the read never rejected. Lesson: a timeout must reject on its own
  rather than trust the callee to honour it.

## Next

- Provisioning: download the uv zip, extract it with `extractZip`, run
  `uv python install`, create the venv, install the dependencies the services
  declare, then write the marker last. The `.pth` holds the absolute
  `servicesDir`; pip.ini is replaced by `UV_DEFAULT_INDEX`; the marker records
  both versions and is the only "already provisioned" signal.
- Then `scripts/python.mjs`: `--setup`, `--doctor`, and argument passthrough.