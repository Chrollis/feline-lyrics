"""Fixtures shared by the media plugin tests."""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import urlparse

import av
import numpy as np

# The tests live inside the plugin, but they exercise the host's allocator and
# the plugin's serve() entry point, so both package roots go on the path before
# anything imports them. The checkout is the only thing that knows the layout.
PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PLUGIN_ROOT.parents[1]

for directory in (
    REPO_ROOT / "packages" / "host" / "backend",
    PLUGIN_ROOT / "backend",
):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from felyrics_host.errors import ServiceError  # noqa: E402
from felyrics_host.loader import load_plugin  # noqa: E402


def call(name, params=None):
    """Runs one internal method through the plugin's real `serve` registry.

    The host's protocol loop has its own tests; these tests are about what
    `serve` registers, so the handler is invoked directly and the two failure
    shapes a client would see are reproduced here.
    """

    loaded = load_plugin(PLUGIN_ROOT)
    handler = loaded.registry.handlers()[name]

    try:
        return {"result": handler({} if params is None else params)}
    except ServiceError as error:
        failure = {"code": error.code, "message": error.message}

        if error.data is not None:
            failure["data"] = error.data

        return {"error": failure}
    except Exception:
        return {
            "error": {
                "code": "core/internal",
                "message": "the handler raised",
            }
        }


def job_file(cache, url):
    """Turns `app://job/<plugin>/<hex>/<name>` into the file on disk."""

    parts = urlparse(url).path.strip("/").split("/")

    if len(parts) != 3:
        raise AssertionError(f"not a job url: {url}")

    return cache / "jobs" / parts[0] / parts[1] / parts[2]


def job_dirs(cache, kind):
    """The job directories whose `.kind` marker names `kind`, across plugins."""

    root = cache / "jobs"

    if not root.is_dir():
        return []

    found = []

    for bucket in sorted(root.iterdir()):
        if not bucket.is_dir():
            continue

        for entry in sorted(bucket.iterdir()):
            if entry.is_dir() and (entry / ".kind").read_text(encoding="utf-8") == kind:
                found.append(entry)

    return found


def write_flac(path, *, rate, layout, frames, value=1000):
    """Writes `frames` samples of a constant, so a round trip can be compared."""

    channels = av.AudioLayout(layout).nb_channels
    # s16 is a packed format: one row, channels interleaved. The value is
    # constant, so interleaving is the same as repeating it.
    samples = np.full((1, frames * channels), value, dtype=np.int16)
    container = av.open(str(path), "w", format="flac")
    stream = container.add_stream("flac", rate=rate, layout=layout)
    frame = av.AudioFrame.from_ndarray(samples, format="s16", layout=layout)
    frame.sample_rate = rate
    container.mux(stream.encode(frame))
    container.mux(stream.encode(None))
    container.close()


def write_video(path, *, width=64, height=48, count=3, rate=10):
    """Writes `count` frames of MPEG-4 video, each a different shade of red.

    The colour changes per frame so an extracted still can be traced back to the
    frame it came from instead of comparing two identical pictures.
    """

    container = av.open(str(path), "w", format="mp4")
    stream = container.add_stream("mpeg4", rate=rate)
    stream.width = width
    stream.height = height
    stream.pix_fmt = "yuv420p"

    for index in range(count):
        pixels = np.zeros((height, width, 3), dtype=np.uint8)
        pixels[:, :, 0] = 40 + (index * 37) % 200
        frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
        frame.pts = index
        container.mux(stream.encode(frame))

    container.mux(stream.encode(None))
    container.close()
