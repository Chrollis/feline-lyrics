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
- Keep this file to rules, state and next. Decisions in force go to
  `memories/decisions.md`; decisions that only explain existing code, and dead
  ends, go to `memories/archive/<yyyy-mm>.md`. Leave a pointer, not a copy:
  this is a working set, not a history.

## State

- Electron shell runs. `npm run dev` opens a 960x640 window, floored at 720x480,
  that shows `pong` fetched over IPC (`ipcMain.handle('ping')`).
- The main process is ESM (`"type": "module"`); the preload is CJS
  (`index.cjs`), because a sandboxed preload cannot be ESM.
- `packages/toolchain` holds provisioning only, grouped by domain: `layout/`
  (paths, env, temp), `process/` (zip), `python/` (target, download, provision,
  pth, ready, requirements, service, doctor, uv).
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
- `services/felyrics/` is the backend: `python -m felyrics` answers one JSON
  object per request on stdio. `server.py` keeps a `METHODS` table that
  `@method` fills, so `ping`, `media/probe`, `media/decode`, `video/probe` and
  `video/frames` register themselves; importing `media.methods` is what
  registers the rest. The renderer reaches them through six IPC channels
  (`media:pick|probe|decode`, `video:pick|probe|frames`), each returning an
  `IpcResult`; a backend failure keeps its `code` because `service.ts` rejects
  with `BackendError`.
- Media work goes to disk under `<cache>/jobs/<kind>/<uuid>/` and the protocol
  answers with paths, not payloads: `<cache>` is user data the OS never collects.
  A bucket is cleared only after a finished result (`_keep_only`), never before,
  so a failed or empty request cannot destroy the file the renderer is playing.
- Paths are inputs: the toolchain takes `{ cacheDir, servicesDir, backendRoot }`
  from the caller and derives the rest, so the CLI and the app can disagree
  about where things live without the library knowing.
- `reference/` is gitignored and holds three kinds of thing: `202609/` is this
  repository's predecessor (the previous AI-built version, same architecture),
  `202606/` is an earlier Rust + Python attempt, `NicoKaraMaker3/` and
  `RhythmicaLyrics/` are third-party references. `ideas/` is split by STATUS,
  not by topic: `to-fix.md`, `fixed.md`, `keep-as-is.md`, with the discussion
  notes (`python-acquisition.md`, `cache-management.md`, `plugin-system.md`)
  kept apart. The reviewer runs in a session the human starts by hand and is
  the only writer of the three status files; no review runs inside a builder
  session. The whole directory is gitignored, so none of it is versioned.

## Decisions

- The decisions in force -- the ones a new step can violate by accident, with
  the reason each exists -- are in `memories/decisions.md`. Read the entries for
  a subsystem before changing it; a step that contradicts one is a proposal to
  change it, not a bug to fix quietly.
- Decisions that only explain code already written, and every dead end this
  repository has hit, are in `memories/archive/2026-11-*.md`. Read them when a
  shape looks redundant or a failure looks familiar.

## Next

- The whole media chain is proven end to end: `app://bundle` serves the page,
  the six IPC handlers reach the backend, and the files the backend writes are
  loadable over `app://media/<kind>/<job>/<file>`. `reference/ideas/to-fix.md`
  is empty; the notes start the next batch from a clean file.
- Next is the first real feature: lyrics parsing (a file plus a line/character
  model), then the timing pipeline on top of the audio that `media/decode`
  already produces. Both Python plugins still come later: annotate/tokenize
  (pure CPU, light) and align/separate (`stable-ts[fw]` CPU plus
  `demucs-infer`/torch, heavy, install-time optional, in its own venv).
