"""Fixtures shared by the media plugin tests."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

import av
import numpy as np


def _find_plugin_root() -> Path:
    """Walks up to the package.json that declares `felyrics`, not a fixed depth.

    The checkout is the only thing that knows how deep this file sits; a copy of
    the plugin outside the repository should still find its own root.
    """

    override = os.environ.get("FELYRICS_PLUGIN_ROOT")

    if override:
        return Path(override).resolve()

    for candidate in Path(__file__).resolve().parents:
        manifest = candidate / "package.json"

        if not manifest.is_file() or not (candidate / "backend").is_dir():
            continue

        try:
            package = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        if isinstance(package.get("felyrics"), dict):
            return candidate

    raise RuntimeError("cannot find the plugin root above this test file")


def _find_host_backend(plugin_root: Path) -> Path:
    """The host package root, found by walking up (or given by the caller)."""

    override = os.environ.get("FELYRICS_HOST_BACKEND")

    if override:
        return Path(override).resolve()

    for candidate in plugin_root.parents:
        backend = candidate / "packages" / "host" / "backend"

        if (backend / "felyrics_host").is_dir():
            return backend

    raise RuntimeError("cannot find packages/host/backend above the plugin")


PLUGIN_ROOT = _find_plugin_root()
HOST_BACKEND = _find_host_backend(PLUGIN_ROOT)

for directory in (HOST_BACKEND, PLUGIN_ROOT / "backend"):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from felyrics_host import server  # noqa: E402
from felyrics_host.loader import load_plugin  # noqa: E402

_loaded = None


def _plugin():
    """Loads and registers the plugin once; `serve` resets no module state."""

    global _loaded

    if _loaded is None:
        loaded = load_plugin(PLUGIN_ROOT)

        for name, handler in loaded.registry.handlers().items():
            server.PLUGIN_METHODS[(loaded.manifest.id, name)] = (
                server.PluginMethod(
                    loaded.manifest.id,
                    frozenset(loaded.manifest.errors),
                    handler,
                )
            )

        _loaded = loaded

    return _loaded


def call(name, params=None):
    """Runs one internal method through the host's real line handler.

    The response is the wire object a client would receive, including `v` and
    `id`; the tests read `result` / `error` from it, so they assert the server's
    shape rather than one written next to the test.
    """

    loaded = _plugin()
    # The host prefixes an internal call with the plugin id; a test that names a
    # short method should go through the same wire shape, not a second one.
    method = name if "/" in name else f"{loaded.manifest.id}/{name}"

    return server.respond(
        json.dumps(
            {
                "v": server.PROTOCOL_VERSION,
                "id": 1,
                "method": method,
                "params": {} if params is None else params,
            }
        )
    )



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
