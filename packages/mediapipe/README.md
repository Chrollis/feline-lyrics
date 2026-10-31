# @felyrics/mediapipe

The renderer media layer for Felyrics: clips as plain data, a timeline index,
the WebSocket transport, and the frame/audio caches. It knows nothing about
lyrics; a subtitle clip is an ordinary clip whose picture comes from a local
subtitle source.

Everything under `src/renderer/clips/` and `src/renderer/transport/` is
DOM-free and runs under `node --test`. The transport talks WebSocket through a
tiny injected `SocketLike` interface, so Chromium's WebSocket and Node's
global WebSocket both plug in unchanged. Frames, audio and the engine add
DOM-bound adapters on top of the same algebra.

## Requirements

- Node.js 22.18 or newer (the test suite runs the TypeScript sources directly).

## The model (slice 1)

```
Clip        { id, kind, span, layer, z, state }   frozen data, never a class
Span        { startMs, durationMs }              half-open, integer ms
VideoClip   + { stream, inSec }
AudioClip   + { stream, inMs, gain? }
SubtitleClip+ { sourceKey, inMs }
```

- `kind` is `video | audio | subtitle`; layers are video 0, audio 1, subtitle 2.
- Time is integer milliseconds everywhere; 1 ms is exactly 48 samples at
  48 kHz, and `SAMPLES_PER_MS` is the only place that factor appears.
- The algebra is payload-agnostic: `moveTo`, `moveBy`, `trimLeft`,
  `trimRight`, `splitAt`, `hitTestAt`. A left trim advances the source
  in-point so the content stays put in song time; a right trim only shrinks.
- Every edit returns a new frozen value, or the argument itself on a no-op, or
  `null` when the request is not a valid edit.

## The index

```
LayerIndex  { clips, starts, ends, startIds, buckets, cursor }
```

- 250 ms buckets answer "what covers t" in O(k) with k = clips in one bucket.
- `layerIndexFor(clips)` caches the index by array identity; a new array means
  a new index, so the engine rebuilds once per document change, not per frame.
- Playback advances a cursor: new clips enter through a binary search on the
  sorted starts, ended ids are compacted in place. Forward cost is O(log n +
  entered + left) per tick.
- `activeInto` / `playbackInto` write into a caller-owned array so the frame
  loop allocates nothing.

## The animation store and the caches (slice 3)

```
AnimationStore  keyframes per (ownerId, path), clip-local ms, pure sampling
evaluateClip    ClipRenderState: opacity, transform, audio gain/pan
FrameCache      decoded frames, numeric (token, frameIndex) keys, playhead LRU
AudioPageCache  1 s planar pages (48 kHz stereo), per-source and pool caps
```

- `sampleChannel` takes each segment's interpolation from its right-hand key,
  holds before the first and after the last key, and solves bezier x -> t.
- Preview values override sampling; `commit()` merges one key per animated path
  (or creates a curve when `AnimationStore` has `autoKey` on) and returns static
  values for the rest.
- Both caches evict by distance from the token's playhead; the newest insertion
  is never evicted and pinned entries are kept until `unpinAll`.

## The engine (slices 4-5)

```
createMediapipe({ connect, presets?: { playback? }, cache?, autoKey?, windowMs?,
                  decodeAudio? })
```

- The engine is a clock slave: `tick(nowMs)` per rAF focuses the caches and
  keeps one prefetch window per active video clip, plus one for every clip
  that starts inside the horizon (`windowMs`) so a cut does not open black. It
  never plays or seeks.
- `videoFrame(clipId, atMs)` is synchronous and never awaits: a hit is `ready`
  (with PNG bytes), a miss starts a window and answers `pending` (with a
  reason), an ack of `count` 0 is remembered as `empty`, and a time outside the
  clip span is `unavailable`. `subtitleFrame` answers `ready` on the first call
  from a registered local `SubtitleSource`, honouring the clip's `inMs`.
- `audioPage(clipId, atMs)` is the audio twin: one 1 s page
  `{status, pageIndex, sampleRate, channels}`. The engine fetches one FLAC
  stream per page, then hands the bytes to the injected `decodeAudio`, which
  returns `{left, right}`; a short tail page is padded to 48000 samples, and a
  page past the source end is answered `empty` and never requested twice.
  A pending page reports why (`inflight`, `no-backend`, `no-decoder`,
  `window-full`), a decoded length that is neither the announced count nor a
  full page is refused and cached nowhere, `tick` prefetches audio before video,
  and audio keeps a reserved in-flight slot so a busy video layer cannot starve
  it.
- One preset is active for the whole surface (`setViewport`). Changing it keeps
  the frames of the old preset: the token carries scale and fps, so an entry
  stays reachable when the user switches back and distance-to-playhead eviction
  reclaims it; a quality switch is a new key, not a purge (Adobe does the same).
- `preview` writes a value (or a whole `Track`) into the overlay;
  `commitPreview` returns `CommitAction[]` - a key for an animated path, or
  `animated: false` for the app to write into the clip as the same undo entry.

## The transport (slice 2)

```
Transport      one socket; request(method, params, {id}) -> Promise<result>
FrameReassembler  per-req_id payloads: one stream (flac) or one frame each (png)
```

- Text messages carry envelopes (`{v, id, method, params}` /
  `{v, id, ok, result | error}` / `{v, type: 'event', event, ...}`) and are
  rejected unless `v` is 1.
- Binary messages are `[4B LE header length][JSON header][payload]`. Audio
  ranges are slices of one FLAC stream, reassembled in `seq` order and checked
  against `ack.bytes` before `onFrame`; video ranges are one PNG per frame with
  its own header (`pts_us`, `frame_index`, `width`, `height`), delivered one
  `AssembledFrame` each and counted against `max(1, ack.count)`.
- Pass `{id}` to `request` when you need `expectBytes(id, ack.bytes)` or
  `expectFrames(id, count)` for a range. The expectation must be bound before
  the first frame: an unbound frame rejects the request (unverifiable bytes are
  worse than a failed one), a repeated ack declaration is accepted mid-stream,
  and a declaration for a finished/abandoned request returns `false`. A bound
  range that stops sending frames fails with `frame-stalled` after
  `frameIdleMs` (default 10 s, 0 disables); reassembly is capped at 8 MiB;
  `closeInfo` keeps the socket close frame and a 4401 close rejects in-flight
  work with code `unauthorized`; listener exceptions are logged, never
  propagated. `request` takes a per-request `timeoutMs` (0 disables it) because
  a video `request_range` builds its window before the ack.
- The credit budget (4 requests, 3 video + 1 reserved audio), scrub
  latest-wins and reconnect live in the engine, not the transport: `onClose`
  settles the dead windows and pages, and the next request reconnects and
  re-hellos. Source ids survive a socket drop because the backend keeps them;
  after a backend restart the app re-opens the path and writes the new id into
  its clips.

## Test

```
npm test --workspace @felyrics/mediapipe
```

117 tests: clip algebra, timeline index, wire codec, reassembly and the
client against an in-memory socket, sampling/remap/evaluation, the frame/page
caches and the engine core (video windows, audio pages, subtitle windows,
reconnect) against a fake transport.
