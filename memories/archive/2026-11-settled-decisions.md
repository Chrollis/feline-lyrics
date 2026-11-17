# Settled decisions, 2026-11

Decisions already baked into the code, moved out of `memories/MEMORY.md` on
2026-11-17. They explain why something looks the way it does; they do not
constrain new work. Read the entry for the subsystem you are about to change,
because "this looks redundant" is usually answered here.

Decisions still in force -- the ones a new step can violate by accident -- live
in `memories/decisions.md`.

What moved here: portable Python, `av` and the GPL build, uv replacing the pbs
download, tar giving way to node-stream-zip, the uv build pin and its flags, the
mirror order, the readiness marker, the root `test` script, and the package
entry points.

- Portable Python (python-build-standalone) instead of the system Python: a
  fresh machine needs no prerequisites, and the version is pinned by us.
- 2026-11 av no longer needs an lgpl FFmpeg: the backend is not shipped with
  the app, so a GPL build is fine and `pip install av` replaces the planned
  lgpl shared build plus `pip wheel av --ffmpeg-dir`.
- 2026-11 uv replaces the pbs download and the probe ladder: uv fetches its own
  python-build-standalone build, so PATH / conda / venv detection disappears.
  uv itself is downloaded with the app, not bundled.
- 2026-11 tar is gone in favour of node-stream-zip: a system tar is not
  guaranteed to read a zip, and a JS library keeps one code path on every
  platform. The name check stays ours, so every refusal shares one code.
- 2026-11 uv 0.13.8's frozen list does include CPython 3.12.15: installing it
  through the USTC mirror took about 80 seconds for 21 MB. uv and the Python
  builds come from the USTC mirror, packages from Tsinghua. Pass
  `--no-bin --no-registry` to `uv python install` so it never writes to
  `~/.local/bin` or the Windows registry.
- 2026-11 readiness is a marker, not an existence check: files can exist in a
  half-finished state, and a version can change under an existing directory.
  Comparing the marker's `uv`, `python` and absolute `services` is the cheap
  question; whether the interpreter actually runs is `--doctor`'s job.
- 2026-11 python builds come from a mirror list, USTC first and GitHub second:
  a brand-new pbs tag can time out on the mirror while GitHub serves it (the
  20261021 asset did exactly that, 14 s on GitHub). USTC stays first because it
  is the fast path in China once its cache is warm.
- 2026-11 `PYTHON_BUILD` pins the pbs build date because uv 0.13.8's manifest
  lists exactly one build for 3.12.15; the date is data, not a preference.
- 2026-11 the root `test` script is `--workspaces --if-present`, so tests are
  as reachable as `typecheck`; a workspace without tests is skipped silently,
  which is right because "has tests" is optional per package.
- 2026-11 `packages/toolchain` declares its entry once, in `exports`: the
  top-level `types` was a byte-for-byte duplicate and is gone. `main` stays
  because it is the entry point for tools that predate `exports`, and nothing
  here is published, so removing it would buy nothing.
