# Backend reference

Every method the backend answers, the arguments it accepts, the files it writes, and
every error code it can produce. The envelope itself is documented in
[protocol](../toolchain/protocol.md); this page is what goes inside `params` and `result`.

## Methods

### `ping`

| | |
| --- | --- |
| `params` | none (or `{}`) |
| `result` | `{"pong": true}` |
| errors | none of its own |

### `media/probe`

Describes the first audio stream without decoding it. Cheap enough to call before
choosing decode parameters.

| | |
| --- | --- |
| `params` | `{"path": string}` |
| `result` | `{"sample_rate": int, "layout": string, "channels": int, "duration": float, "codec": string}` |
| errors | `protocol/invalid-request`, `media/open-failed`, `media/no-audio-stream` |

`duration` is the container's, in seconds; `0.0` when the container does not say.

### `media/decode`

Decodes the first audio stream and writes it as FLAC into the cache.

| | |
| --- | --- |
| `params` | `{"path": string, "rate"?: int > 0, "layout"?: string}` — omitted means "keep the source's" |
| `result` | `{"path": string, "sample_rate": int, "layout": string, "channels": int, "frames": int, "duration": float}` |
| errors | `protocol/invalid-request`, `media/open-failed`, `media/no-audio-stream`, `media/unknown-rate`, `media/unknown-layout`, `media/unsupported-format`, `media/decode-failed`, `media/encode-failed` |

The returned `sample_rate`/`layout` describe what was written, not what was read.

### `video/probe`

| | |
| --- | --- |
| `params` | `{"path": string}` |
| `result` | `{"width": int, "height": int, "fps": float, "duration": float, "codec": string}` |
| errors | `protocol/invalid-request`, `media/open-failed`, `media/no-video-stream` |

### `video/frames`

Writes one PNG per requested time and answers with the file list.

| | |
| --- | --- |
| `params` | `{"path": string, "start"?: float >= 0, "step"?: float > 0, "count"?: 1..240, "width"?: 16..4096}` |
| `result` | `{"dir": string, "width": int, "height": int, "fps": float, "frames": [{"index": int, "requested": float, "at": float, "path": string}]}` |
| errors | `protocol/invalid-request`, `media/open-failed`, `media/no-video-stream`, `media/unsupported-format`, `media/decode-failed`, `media/encode-failed` |

| Argument | Default | Meaning |
| --- | --- | --- |
| `start` | `0.0` | Seconds; the first requested time |
| `step` | `0.5` | Seconds between requested times |
| `count` | `1` | Up to `video.MAX_FRAMES` (240) |
| `width` | source width | Output width in pixels; height follows the aspect ratio, rounded to an even number |

`requested` is the time that was asked for, `at` the presentation time of the frame that
answered it. They differ whenever a step falls between two frames: at 10 fps, `step=0.15`
asks for `0.15` and gets the frame at `0.2`.

An empty result is legal — `start` past the end answers `{"dir": "", "width": 0,
"height": 0, "frames": []}` and deletes nothing.

## Errors

`ServiceError(code, message, data=None)`. `message` is English fallback text; anything a
client renders belongs in `data`.

| Code | Raised when | `data` |
| --- | --- | --- |
| `protocol/invalid-json` | The line is not JSON | — |
| `protocol/invalid-request` | Not an object, `id` missing or not an integer, no `method`, `params` not an object, an argument of the wrong type, outside its range, or not finite | — |
| `protocol/version-mismatch` | `v` is not this backend's version | `{"declared": any, "expected": int}` |
| `method/not-found` | No method by that name | — |
| `internal/error` | A handler raised something no one planned for; the traceback goes to stderr | — |
| `media/open-failed` | The file is missing, unreadable, or not a container libav knows | — |
| `media/no-audio-stream` | The container has no audio | — |
| `media/no-video-stream` | The container has no video | — |
| `media/unknown-rate` | `rate` is not a positive number | — |
| `media/unknown-layout` | `layout` is not a layout libav knows | — |
| `media/unsupported-format` | The source or the requested conversion cannot be represented | — |
| `media/decode-failed` | Decoding stopped partway | — |
| `media/encode-failed` | Encoding the result failed | — |

`protocol/*` means the caller's line was wrong. `internal/error` means our code was; it is
the only code that should be treated as a bug report.

## Files on disk

```
<cache>/
  jobs/
    audio/<32 hex>/audio.flac
    frames/<32 hex>/0001.png, 0002.png, ...
```

- `<cache>` is the directory passed to `--cache`.
- One directory per result, named by a random 32-character hex id; the desktop turns it
  into `app://media/<kind>/<id>/<file>`.
- A new result in a bucket deletes the bucket's earlier directories, but only after the
  new result is finished. A failed or empty request leaves the previous files alone —
  the renderer may still be playing them.
- The backend never deletes anything older than the previous result. Reclaiming space is
  a frontend concern.

## Configuration

| Setting | Where it comes from |
| --- | --- |
| Cache root | `--cache <dir>`, required; `runtime.configure()` fixes it for the process |
| Interpreter, packages | The backend venv, provisioned by the toolchain |
| Protocol version | `server.PROTOCOL_VERSION`, a constant |

Nothing else is read from the environment. Two backends started by different callers
cannot disagree about the cache because it is an argument, not a discovery.

## Tests

```bash
npm run python -- -m unittest discover -s services/tests -v
```

| Module | Covers |
| --- | --- |
| `test_server.py` | The envelope, version refusal, malformed input, handler errors keeping their code |
| `test_audio.py` | Probe, decode with and without resampling, FLAC round trip |
| `test_video.py` | Probe, still times, scaling, empty batch, genericity of the decode loop |
| `test_image.py` | PNG encoding and the pixel-shape contract |
| `test_media_methods.py` | Argument validation, job directories, the CLI contract |
