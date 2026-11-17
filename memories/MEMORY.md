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
- When this file passes ~250 lines, move settled entries to
  `memories/archive/<yyyy-mm>.md` and keep a pointer. This is a working set,
  not a history.

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
  venv, install packages.
- `python/provision.ts` is the only entry point that builds a backend:
  `downloadUv`, `installPython`, `createVenv`, `writePth`, `installPackages`,
  then the marker. `pth.ts` writes one absolute line into the venv's
  site-packages, because a relative path would follow the working directory.
- `python/service.ts` is the protocol client: one spawn, numeric ids pair
  responses with requests, stdout is split into lines only after `StringDecoder`
  decodes a chunk, stderr never reaches the protocol, and a dead process rejects
  whatever is still pending.
- The Electron main process owns one backend (`apps/desktop/src/main/backend.ts`):
  spawned on first ping, stopped by closing stdin, paths resolved from the repo in
  development and from `userData`/`resources` when packaged.
- `python/doctor.ts` answers the other question -- is this backend usable right
  now? It runs both binaries, reads the `.pth` and the marker, and returns a
  report the CLI prints and the app can render; nothing is written.
- `services/felyrics/` is the backend's first process: `python -m felyrics`
  answers one JSON line per request on stdio, with `ping` as the only method.
  The protocol, not the feature, is what exists today.
- Paths are inputs: the toolchain takes `{ cacheDir, servicesDir, backendRoot }`
  from the caller and derives the rest, so the CLI and the app can disagree
  about where things live without the library knowing.
- `reference/` is gitignored and holds three kinds of thing: `202609/` is this
  repository's predecessor (the previous AI-built version, same architecture),
  `202606/` is an earlier Rust + Python attempt, `NicoKaraMaker3/` and
  `RhythmicaLyrics/` are third-party references. `ideas/` is split by STATUS,
  not by topic: `to-fix.md`, `fixed.md`, `keep-as-is.md`, with the discussion
  notes (`python-acquisition.md`, `cache-management.md`, `plugin-system.md`)
  kept apart. `learning/syntax-log.md` is the agent-maintained syntax log. The
  whole directory is gitignored, so none of it is versioned.

## Decisions

- Portable Python (python-build-standalone) instead of the system Python: a
  fresh machine needs no prerequisites, and the version is pinned by us.
- The Python backend is one long-lived process speaking JSON lines on stdio.
  Not a web socket, not one process per call. Since 2026-11 it is one process
  per venv: core plugins share the main venv's process, a third-party plugin gets
  its own process, and the host routes a method to whichever process owns it.
- Plugin-declared dependencies: a feature asks for packages and the toolchain
  installs them. No feature assumes a preinstalled environment.
- 2026-11 plugins run their frontend code in `utilityProcess` from day one, so
  their UI is limited to declarative contributions the host renders. Rendering
  React from a plugin would have made the later move a breaking change for every
  plugin; a custom panel gets a sandboxed iframe instead.
- 2026-11 no hot reload for plugins: the host gives each one a `ctx.storage`
  key-value space and a restart, because in-process state cannot be migrated.
  Anything in flight is cancelled on restart, so work must be re-entrant or
  checkpointed.
- 2026-11 plugins never import each other. Shared capability is a host service
  (`ctx.services.get`), so load order does not matter and unload has no graph.
- Directory roles are lifecycle, not taste: `python/` is an artifact,
  `cache/` is reusable input, scratch work goes to the OS temp directory.
- 2026-11 `tempDir` is the caller's disposable scratch (`mkdtemp` + `finally`),
  never a setting: the OS already has `TEMP`, and a second truth in settings
  would leave orphan directories behind. `cacheDir` is the one a user relocates
  when a disk fills.
- Sources are grouped by domain, not by layer, so a helper shared by two tools
  has one obvious home instead of an "utils" drawer.
- 2026-11 `AGENTS.md` is injected into every session, so it carries behaviour
  only; state, decisions and dead ends live here. A step closes when the human
  can restate the diff, not when the tests are green.
- Failures we expect and branch on carry a `ToolchainError` code
  (`domain/reason`) and structured `context`; unexpected ones (spawn ENOENT,
  killed process) stay native, so "the archive is at fault" is a code prefix,
  not a class.
- 2026-11 the service client has no restart policy: a backend that dies is a
  decision for its owner, so the client rejects the pending requests and names
  the exit code instead of respawning behind the caller's back.
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
- 2026-11 the root `npm run build` builds the toolchain first, through npm's
  `prebuild` hook, because the desktop main bundle keeps `@felyrics/toolchain`
  external: a stale `packages/toolchain/out` is then silently shipped and its old
  code runs. `dev` deliberately has no `predev`, so a fast restart does not
  rebuild the toolchain.
- 2026-11 uv 0.13.8's frozen list does include CPython 3.12.15: installing it
  through the USTC mirror took about 80 seconds for 21 MB. uv and the Python
  builds come from the USTC mirror, packages from Tsinghua. Pass
  `--no-bin --no-registry` to `uv python install` so it never writes to
  `~/.local/bin` or the Windows registry.
- 2026-11 the uv assets are a per-platform table, not one constant: uv ships a
  different file per OS and arch, and only the zip form is unpacked today. The
  target is cross-platform; `SUPPORTED_TARGETS = ['win32-x64']` is the honest
  statement of what works NOW, and the Windows-only `backendPaths()` sitting
  next to a six-row `TARGETS` is a work item (`reference/ideas/to-fix.md`
  item 3), not a decision to stay on Windows.
- 2026-11 readiness is a marker, not an existence check: files can exist in a
  half-finished state, and a version can change under an existing directory.
  Comparing the marker's `uv`, `python` and absolute `services` is the cheap
  question; whether the interpreter actually runs is `--doctor`'s job.
- 2026-11 uv runs with an injected environment, never the inherited one: every
  `UV_*` and `PIP_*` variable is dropped first, so a machine with its own uv
  0.11 (this one has it in PATH) cannot pick the interpreter or the index. The
  backend's own `uv.exe` is the only uv the toolchain calls.
- 2026-11 python builds come from a mirror list, USTC first and GitHub second:
  a brand-new pbs tag can time out on the mirror while GitHub serves it (the
  20261021 asset did exactly that, 14 s on GitHub). USTC stays first because it
  is the fast path in China once its cache is warm.
- 2026-11 `PYTHON_BUILD` pins the pbs build date because uv 0.13.8's manifest
  lists exactly one build for 3.12.15; the date is data, not a preference.
- 2026-11 stdout on the backend is the protocol channel and nothing else: one
  JSON object per line, diagnostics on stderr, both streams reconfigured to
  UTF-8 because Windows consoles default to a legacy code page. A handler that
  raises answers `internal/error` and logs its traceback to stderr, so one bad
  request cannot end a session that is meant to run for hours.
- 2026-11 the root `test` script is `--workspaces --if-present`, so tests are
  as reachable as `typecheck`; a workspace without tests is skipped silently,
  which is right because "has tests" is optional per package.
- 2026-11 `packages/toolchain` declares its entry once, in `exports`: the
  top-level `types` was a byte-for-byte duplicate and is gone. `main` stays
  because it is the entry point for tools that predate `exports`, and nothing
  here is published, so removing it would buy nothing.

## Dead ends

- 2026-11 Electron exited at startup with `0x80000003` and printed nothing.
  The cause was the workspace directory carrying a Low integrity label, not
  the Electron version. Check with `icacls . | findstr Mandatory`; repair it with
  `npm run unblock` (removes the sandbox deny ACEs and sets the label to Medium).
- 2026-11 `ELECTRON_RUN_AS_NODE=1` in the harness shell makes `electron` run as
  plain node, so the main bundle dies on `does not provide an export named
  'BrowserWindow'`. Unset it before `npm run dev`; the human's own terminal does
  not have it.
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
- 2026-11 A test that hangs with no output is usually the fixture, not the
  parser: the fake service answered with JSON but no trailing newline, so the
  client waited for a line end that never came. Wrong side, on purpose.

## Next

- The toolchain is one step from done: port audio/video decoding into
  `services/felyrics/media/` and wire a dependency declaration into `provision`,
  then leave the toolchain alone.
- After that, two Python plugins: annotate/tokenize (pure CPU, light) and
  align/separate (`stable-ts[fw]` CPU + `demucs-infer`/torch with CPU or CUDA,
  heavy and install-time optional). Nothing is bundled, so the heavy half can be
  an on-demand install into its own venv.
- Then the first real feature: lyrics parsing, and the timing pipeline after it.