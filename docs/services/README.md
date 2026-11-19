# Backend

The Python side of this project: one long-lived process that the desktop app starts and
talks to over stdio, JSON lines in, JSON lines out. It is not a server and it opens no
port; whoever starts it owns its stdin and stdout.

```bash
python\venv\Scripts\python.exe -m felyrics --cache cache     # starts and waits for a line
npm run python -- -m felyrics --cache cache                  # same, through the repo CLI
```

The `--cache` argument is required. The process writes job files under
`<cache>/jobs/`, and only the caller knows where the app keeps its state; a backend that
invents its own scratch directory leaves files nobody can find again.

## What it does today

| Method | Purpose |
| --- | --- |
| `ping` | Proves the pipe is alive |
| `media/probe` | What audio is in this file |
| `media/decode` | Those samples, as a playable file in the cache |
| `video/probe` | What video is in this file |
| `video/frames` | Stills at chosen times, written as PNG files |

The wire format, the version rule and the error vocabularies are in
[protocol](../toolchain/protocol.md); this section documents the backend as it is built.

## Documentation

| Page | Kind | Answers |
| --- | --- | --- |
| [reference.md](reference.md) | reference | Every method, parameter, error code and file the backend produces |
| [media.md](media.md) | explanation | Why decode and stills are shaped the way they are |

## Layout

```
services/
  requirements.txt        native dependencies of the application itself
  felyrics/
    __main__.py           argument parsing, UTF-8 stdio, the serve loop
    server.py             the protocol: registry, dispatch, answers
    errors.py             ServiceError: the one type handlers raise
    runtime.py            settings the protocol does not carry (the cache root)
    media/
      methods.py          the four methods, argument validation, job directories
      container.py        opening a container, reading its duration
      audio.py            probe, decode, save
      video.py            probe, and a generator of stills
      image.py            pixels to PNG bytes
  tests/                  fixtures plus four test modules
```

One module per medium. Every failure crosses the protocol boundary as a `ServiceError`
with a `domain/reason` code, so a client branches on the code and never on a libav
exception.

## Dependencies

`requirements.txt` names what the application itself needs: `av` and `numpy`, pinned.
The toolchain installs that file into the backend venv during `--setup`, and `--doctor`
reports a dependency that does not import.

Plugin dependencies do not belong here. A plugin declares its own and gets its own venv,
so upgrading one plugin cannot move a library under a running method.

## Scope

In scope: media primitives (decode, stills, encode) and, later, lyrics parsing and
timing.

Out of scope: the protocol itself (see the toolchain), anything that needs a window, and
installing Python — the process is already running by the time it is asked to do
anything.

## Testing

```bash
npm run python -- -m unittest discover -s services/tests -v
```

The tests run against the venv interpreter, which is the only interpreter that has `av`.
`services/tests/support.py` writes real media files (a constant-tone FLAC, a three-frame
MPEG-4 clip) so decoding is tested against libav rather than against a mock.
