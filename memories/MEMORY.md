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
  (paths, env), `process/` (tar), `python/` (target, download, archive). The
  Python backend, its stdio protocol and ffmpeg are not written yet.
- `python/archive.ts` lists the members first, rejects any name that could
  escape the destination, and only then lets tar write. 29 tests pass.

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

## Dead ends

- 2026-11 Electron exited at startup with `0x80000003` and printed nothing.
  The cause was the workspace directory carrying a Low integrity label, not
  the Electron version. Check with `icacls <dir> | findstr Mandatory`.
- 2026-11 The stall-timeout test hung forever. The fake fetch ignored the abort
  signal, so the read never rejected. Lesson: a timeout must reject on its own
  rather than trust the callee to honour it.

## Next

- Readiness markers, the provisioning entry, and `scripts/python.mjs`.
- Discuss the cross-platform Python acquisition ladder (uv may replace most of
  it) before writing `provision()`.