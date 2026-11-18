# Dead ends, 2026-11

Walls this repository has already hit, moved out of `memories/MEMORY.md` on
2026-11-17 so the working set stays short. Read this when a failure feels
familiar, or before spending an hour on something that looks like a new bug.

Each entry is a symptom first, then the cause. The value is the recognition, not
the story.

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
- 2026-11 `<audio>` stayed silent on an `app://media/...flac` URL while `<img>`
  loaded from the same origin: a custom scheme needs `stream: true` in
  `registerSchemesAsPrivileged`, otherwise Chromium refuses to stream media over
  it and reports `MediaError` code 4 (src not supported) with an empty message.
  The same probe disproved the guess that the missing `Content-Type: audio/flac`
  was the cause -- Chromium sniffs the flac bytes and plays it either way.
- 2026-11 A probe that bundles Electron app code must run with
  `ELECTRON_RUN_AS_NODE` unset (see above) and, when the probe is ESM, import
  electron as a default export: named imports fail with "does not provide an
  export named ...".
