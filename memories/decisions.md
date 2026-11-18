# Decisions in force

The decisions a new step can violate by accident, with the reason each one
exists. Split out of `memories/MEMORY.md` on 2026-11-17 so the working set stays
short; `memories/MEMORY.md` now points here instead of carrying them.

Read the entries for a subsystem before changing it. A step that contradicts an
entry here is a proposal to change the decision, not a bug to fix quietly: say
which entry it contradicts, and let the human decide.

Decisions that only explain code already written -- portable Python, `av`, uv
replacing pbs, tar to zip, the uv build pin, the mirror order, the readiness
marker, the root `test` script, the package entry points -- are in
`memories/archive/2026-11-settled-decisions.md`.

## The backend process

- The Python backend is one long-lived process speaking JSON lines on stdio.
  Not a web socket, not one process per call. Since 2026-11 it is one process
  per venv: core plugins share the main venv's process, a third-party plugin gets
  its own process, and the host routes a method to whichever process owns it.
- 2026-11 the service client has no restart policy: a backend that dies is a
  decision for its owner, so the client rejects the pending requests and names
  the exit code instead of respawning behind the caller's back.
- 2026-11 stdout on the backend is the protocol channel and nothing else: one
  JSON object per line, diagnostics on stderr, both streams reconfigured to
  UTF-8 because Windows consoles default to a legacy code page. A handler that
  raises answers `internal/error` and logs its traceback to stderr, so one bad
  request cannot end a session that is meant to run for hours.
- 2026-11 execa runs long commands (`uv python install` takes minutes) so the
  Electron main process never blocks. The long-lived Python service will still
  use `child_process.spawn`, which is what an interactive stdio session needs.

## Plugins

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

## Layout and placement

- Directory roles are lifecycle, not taste: `python/` is an artifact,
  `cache/` is reusable input, scratch work goes to the OS temp directory.
- 2026-11 `tempDir` is the caller's disposable scratch (`mkdtemp` + `finally`),
  never a setting: the OS already has `TEMP`, and a second truth in settings
  would leave orphan directories behind. `cacheDir` is the one a user relocates
  when a disk fills.
- Sources are grouped by domain, not by layer, so a helper shared by two tools
  has one obvious home instead of an "utils" drawer.
- 2026-11 the uv assets are a per-platform table, not one constant: uv ships a
  different file per OS and arch, and only the zip form is unpacked today. The
  target is cross-platform; `SUPPORTED_TARGETS = ['win32-x64']` is the honest
  statement of what works NOW, and the Windows-only `backendPaths()` sitting
  next to a six-row `TARGETS` is a work item (`reference/ideas/to-fix.md`
  item 3), not a decision to stay on Windows.

## Failures and boundaries

- Failures we expect and branch on carry a `ToolchainError` code
  (`domain/reason`) and structured `context`; unexpected ones (spawn ENOENT,
  killed process) stay native, so "the archive is at fault" is a code prefix,
  not a class.
- 2026-11 an IPC handler returns a result, never a rejection:
  `{ ok: true, value } | { ok: false, code, message }` (`asResult` in
  `apps/desktop/src/main/index.ts`). A rejected handler crosses the boundary as
  one flattened string, so the `code` that every caller is supposed to branch on
  disappears exactly at the process edge.
- 2026-11 two vocabularies, two classes: a failure the *backend reported* is a
  `BackendError` (its `code` comes from the protocol: `media/*`, `protocol/*`,
  `method/not-found`, `internal/error`), a failure the *toolchain observed* is a
  `ToolchainError`. Nothing client-side may reuse a backend code -- the backend
  did not say it. A dead process, a closed pipe or a request that never comes back
  is `backend/unavailable` / `backend/timeout`.
- 2026-11 every backend request carries a deadline, and it is a default
  (`DEFAULT_REQUEST_TIMEOUT_MS`, 30 s), not an option: a request that names no
  `timeoutMs` still ends, so "I forgot" cannot mean "wait forever". The main
  process then gives each surface its own budget (5 s for `ping`, because it is
  the liveness check; 30 s for probe and decode; 5 min for a still batch). A
  timeout stops waiting, not the backend: only idempotent methods are safe to
  retry, which is why the comment says so. Without a deadline a stalled method
  leaves the renderer spinning forever with nothing to branch on.
- 2026-11 the long-lived backend is started with `node:child_process.spawn`, not
  `execa`: `execa` exists to run a command to completion and hand back collected
  output, while this client needs a duplex pipe it owns for hours, decodes each
  stream itself (`StringDecoder`) and pairs responses by id. `uv` stays on
  `execa` because those are short commands whose whole output we want.
- 2026-11 a malformed answer is the client's own code, never the backend's:
  `backend/protocol`. If the backend sends an `error` without a string `code`, the
  request is rejected here instead of becoming a brand-new backend code by
  accident. A non-numeric `id` cannot be matched to a request at all (guessing
  `String(id)` would bless a broken backend), so it only raises a protocol error
  and the request ends on its deadline.
- 2026-11 the cancel plumbing is library-only until something can press it:
  `signal` reaches `download`/`uv`/`provision`, and `scripts/python.mjs` passes
  none, because the CLI's only cancel is Ctrl+C -- which on Windows kills the
  whole console process group, so "the process exited" proves nothing about our
  handler. It gets wired when the GUI has a cancel button (stop the backend first,
  then abort the setup) or when a setup step grows long enough to need a timeout.
  Until then a hard kill leaves a `.part` file, which the next attempt truncates.
- 2026-11 a cancellation is a decision, not a failure to retry: `download()` fails
  with `download/cancelled` (the caller's own `abort()` reason rides along as `cause`)
  and never retries, because a retry would ignore the user for two more backoffs.
  The abort is raced against the body read and the backoff, not checked between
  chunks: a transport that ignores its signal parks the loop inside `read()`, and
  nothing of ours runs until the idle timer fires.
- 2026-11 the stdio envelope carries `v` and each side states its own version:
  a request declares the version the sender speaks, an answer declares the
  receiver's, because nobody can reply in a format they do not implement. What
  this catches is a backend process left running from an older checkout -- the
  files on disk are current while the process that answers is not. A wrong or
  missing `v` is `protocol/version-mismatch` on the backend and
  `backend/version-mismatch` on the client, and the request it belongs to is
  rejected at once instead of waiting out its deadline.
- 2026-11 the protocol's `error` object may carry a `data` object, open on the
  wire and closed on our side: the backend can add a field to a new error without
  a protocol bump, while `ToolchainErrorContext` stays an enumerable type -- the
  client copies the two numbers it knows (`declared`, `expected`) and ignores the
  rest. `message` is English fallback text, so anything a person is meant to see
  has to arrive as a field; the version mismatch was the first error that had
  something renderable to say in both directions.
- 2026-11 a download failure is a code, not a bare `Error`: 4xx, an empty body and
  an exhausted retry all end as `download/failed` with the HTTP `status` kept in
  the context, while anything the transport itself throws stays native. Without
  it a plugin UI cannot tell "the mirror said no" from "the user pressed cancel"
  (`download/cancelled`), which are two different sentences to show a person.
- 2026-11 a logged url is cut to scheme, host and path: query strings on these
  mirrors and on future signed urls carry credentials, and an error context ends
  up in logs and screenshots. The query is never hashed either -- a digest of a
  secret is still a secret with no reader that can use it.
- 2026-11 the renderer bridge has one declared shape,
  `apps/desktop/src/preload/api.ts` (`FelyricsApi` + `IpcResult`), imported with
  `import type` by the preload, the renderer and the main process. Two hand-copied
  shapes compile on both sides and only fail at runtime as "is not a function".
- 2026-11 uv runs with an injected environment, never the inherited one: every
  `UV_*` and `PIP_*` variable is dropped first, so a machine with its own uv
  0.11 (this one has it in PATH) cannot pick the interpreter or the index. The
  backend's own `uv.exe` is the only uv the toolchain calls.
- 2026-11 the built renderer is served from `app://bundle` by a privileged
  standard scheme, not from `file://`: `file://` has no usable origin, so a CSP on
  it either gets ignored or has to trust everything, and modules/fetch/storage do
  not behave. The handler reads the file itself and answers with an explicit
  `Content-Type` plus `Content-Security-Policy`, because a `.js` served as
  `application/octet-stream` breaks `<script type="module">` far from its cause.
  `npm run dev` still loads `http://localhost` from Vite, where the policy does
  not apply -- so CSP is verified in `preview`, never in `dev`.
- 2026-11 the backend's own files get a second host on the same scheme,
  `app://media/<kind>/<job>/<file>`, rather than a token map or a path under the
  bundle: a kind from a fixed list, a `uuid4().hex` job directory and a file name,
  so one regex plus the separator guard covers it and no state has to be kept in
  sync. The renderer is still handed a URL, never a path -- `mediaUrlFor`
  converts, and a file that is not inside a job directory gets `null` instead of
  a guess. The three segments are the layout the backend really writes, buckets
  included: a two-segment rule looks right in a test and silently yields `null`
  for every real result.
- 2026-11 the `app` scheme is registered with `stream: true` as well as
  `standard`/`secure`/`supportFetchAPI`/`corsEnabled`, because Chromium will not
  stream media over a custom scheme without it: `<audio>`/`<video>` fail with
  `MediaError` code 4 and an empty message while images from the same origin
  load, so the symptom points at the file instead of the privilege. A content
  type alone does not fix it -- Chromium sniffs a flac and plays it either way.

## Build

- 2026-11 the root `npm run build` builds the toolchain first, through npm's
  `prebuild` hook, because the desktop main bundle keeps `@felyrics/toolchain`
  external: a stale `packages/toolchain/out` is then silently shipped and its old
  code runs. `dev` deliberately has no `predev`, so a fast restart does not
  rebuild the toolchain.

## Working agreement

- 2026-11 `AGENTS.md` is injected into every session, so it carries behaviour
  only; state, decisions and dead ends live here. The human decides and does not
  read code, so a step closes when it is committed and reported, not on a
  reviewer's pass; green tests only prove what the tests claim.
- 2026-11 the reviewer is a separate session the human starts by hand, never a
  teammate. A durable teammate's message resumes the builder's turn, so a review
  held inside a step never ends: the builder reports, gets woken, and reports
  again without the human's floor. Review findings therefore arrive as the next
  step's input, and a step that is already reported never waits for them.
