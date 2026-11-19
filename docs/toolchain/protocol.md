# Protocol

The backend is one long-lived process: `python -m felyrics --cache <dir>`. It listens on
no port. One line of stdin is one request; one line of stdout is one answer. stdout
carries the protocol only — diagnostics go to stderr.

- Client: `src/python/service.ts`
- Server: `services/felyrics/server.py`

## Envelope

```jsonc
// request
{"v": 1, "id": 7, "method": "media/decode", "params": {"path": "…", "rate": 16000}}

// success
{"v": 1, "id": 7, "result": {"path": "…", "sample_rate": 16000, "layout": "mono",
 "channels": 1, "frames": 16000, "duration": 1.0}}

// failure
{"v": 1, "id": 7, "error": {"code": "media/open-failed", "message": "cannot open …", "data": {}}}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `v` | yes | Envelope version, currently `1` |
| `id` | yes | Client-assigned, increasing; the backend returns it unchanged |
| `method` | request | A key of the backend's method table |
| `params` | request | Object; omitted means `{}` |
| `result` | answer | Present on success |
| `error` | answer | Present on failure, with a string `code` and `message`; `data` is optional |

## Version negotiation

Both sides state the version they speak. A line declaring another version is refused
immediately rather than after a deadline: the client throws `backend/version-mismatch`,
the backend answers `protocol/version-mismatch`. A receiver cannot answer in a version it
does not know, so the mismatch is reported as it stands.

The versions travel as fields (`declared`, `expected`), never parsed back out of the
message: `message` is English fallback text and stops being machine-readable once
translated. In practice a mismatch means one process is not the build the other expects —
typically an older backend still running from an earlier checkout.

## Client behaviour

| Rule | Reason |
| --- | --- |
| One `StringDecoder` per stream | A chunk boundary can fall inside a character and inside a line; decode before splitting, and never share a decoder between stdout and stderr — a half-received stderr character would swallow the head of the next stdout line |
| Every request has a deadline | `DEFAULT_REQUEST_TIMEOUT_MS` unless the request names one. There is no "wait forever": an unbounded request can hang the caller for the life of the process |
| A timeout stops waiting, not the backend | The request may still finish server-side, so only idempotent methods are safe to retry |
| Late and duplicate answers are diagnostics | An id the client handed out but no longer waits for produces `answer to id N, which is no longer pending`; an id never sent is called out separately. Neither reaches the caller |
| Death and failed starts reject everything pending | `backend/unavailable`, including from `close()`. A failed spawn emits `error` and never `exit`, so both are watched |
| Malformed answers fail their own request | A missing string `code` or `message` is `backend/protocol`: our code has to change, not the backend's vocabulary |

## Error vocabularies

| Class | Produced by | Examples | Handling |
| --- | --- | --- | --- |
| `BackendError` | The backend | `media/open-failed`, `method/not-found`, `protocol/invalid-request`, `internal/error` | `code` passes through to the UI; a new backend method needs no toolchain release |
| `ToolchainError` | The toolchain or the shell | `download/failed`, `backend/timeout`, `backend/unavailable`, `target/unsupported` | Closed list in `src/errors.ts`; the shell must not reuse a backend code |

Both expose `code` as a field, so the desktop `asResult()` can wrap an IPC failure as
`{ ok: false, code, message }` instead of a string that has lost the code.

## Result files

The protocol carries paths, not payloads.

- The backend writes results to `<cache>/jobs/<kind>/<uuid>/<file>` and answers with
  absolute paths. `<cache>` is user data; the OS never collects it.
- A bucket is cleared only **after a finished result** (`_keep_only`). A failed or empty
  request leaves the previous files untouched, because the renderer may be playing them.
- The desktop turns a path into `app://media/<kind>/<hex>/<file>`. The rule must follow
  the real layout: a two-segment rule builds `null` for every real result.

## Trying it by hand

```bash
echo '{"v":1,"id":1,"method":"ping"}' | python\venv\Scripts\python.exe -m felyrics --cache cache
# {"v": 1, "id": 1, "result": {"pong": true}}

npm run python -- -m unittest discover -s services/tests -v   # server tests
npm test -w @felyrics/toolchain                               # client tests
```
