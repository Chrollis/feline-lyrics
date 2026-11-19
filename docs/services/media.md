# Why media looks like this

The parts of the media layer that are not obvious from a signature: why there are two
methods per medium instead of one, why the parameters are the caller's, and where the
memory goes.

## Two methods, not one with a `format`

`media/probe` answers "what is in this file"; `media/decode` answers "turn it into what I
asked for". A single method taking an output `format` would make the result shape depend
on an argument — a PNG batch has nothing in common with a FLAC file — so every caller
would branch on `format` anyway, and the test matrix would multiply by the number of
containers the backend can write.

Two methods also survive a real need: the frontend has to know a file's duration before
it can ask for a sensible decode, and holding a decode open while it asks would make the
request two round trips for one decision.

## Parameters belong to the caller

`rate` and `layout` are decode parameters, not policy:

- Timing work wants 16 kHz mono: speech models are trained on it, and it is a quarter of
  the memory.
- Playback wants 48 kHz stereo, because that is what the audio device will take.

Only the caller knows which of the two it is doing, and the same file serves both. The
container, by contrast, is transport and belongs to the method: the frontend asks for
"playable audio", not for FLAC specifically. A future `media/samples` method — raw
float32 for a model that wants it — is the answer for that case, not a `format`
parameter.

Omitting `rate` or `layout` keeps the source's value, so the common case needs no
arguments at all.

## Resampling runs in libswresample

`av.AudioResampler` rather than numpy arithmetic. Encoders emit `skip_samples` and
`initial_padding` metadata describing samples that were consumed to prime the filter;
doing the conversion by hand loses that, and on AAC the result is a short silence at the
start of the file — audible as a mismatch once lyrics are timed against it.

The decoded samples are `float32` in `[-1, 1]`, planar: one row per channel. Converting
to `int16` for FLAC is the only place the range matters, and it is done in that order —
clip, then round, then cast:

```python
np.round(np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
```

`astype(int16)` alone truncates toward zero *and* wraps: `1.02` becomes `-32114`, an
inverted click. `round` before the cast keeps the quantisation error at half a unit
instead of a whole one.

## Stills are streamed, not collected

`video.frames()` is a generator and the method writes each PNG before the next frame is
decoded. The alternative — decode all, then encode all — holds every frame at once: 240
stills of 1920x1080 raw pixels is about 1.5 GB. Measured peak working set for a 60-frame
1920x1080 batch, 0.2 s apart:

| Strategy | Peak memory |
| --- | --- |
| Collect, then write | +273 MiB |
| Write as decoded | +0 MiB |

(The measurement is `PeakWorkingSetSize` from `psapi`; `tracemalloc` reports zero because
numpy's buffers are invisible to it, and Windows has no `resource` module.)

The batch size is therefore a count, not a memory limit: `MAX_FRAMES = 240` is about how
many stills a timeline view asks for, and streaming keeps the cost independent of it.

## Time, frame, and the truth in between

A request names times, but a video has frames at its own pace. At 10 fps a step of 0.15 s
lands between frames, so the answer reports both numbers: `requested` (what the caller
asked for) and `at` (the frame that answered it). Collapsing them would put a still at the
wrong place on a timeline and hide the drift.

Seeking is best effort. `_seek` jumps to the nearest keyframe before the target and
decodes forward; if the container cannot seek, decoding starts at the beginning and the
same loop still produces the right times, only slower.

Scaling goes through `VideoFrame.reformat`, which is libswscale: one C pass over the
frame instead of a numpy loop, and the chroma conversion happens in the same step. The
height is rounded to an even number because most pixel formats require it and a downscale
otherwise fails on the last row.

## Where results live

`<cache>/jobs/<kind>/<id>/`, one bucket per kind. The kind is in the path because the
desktop has to build a URL from it (`app://media/<kind>/<id>/<file>`), and a URL rule that
does not know the bucket can only serve one of them.

The rule is "the newest result wins, and only once it exists". A failed decode or an
empty still request removes its own partial directory and leaves the previous one — the
renderer may be playing it. Nothing older than the previous result is collected; that is
the frontend's job, because it is the only party that knows what is still on screen.
