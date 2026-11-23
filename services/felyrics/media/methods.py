"""Temporary adapter from the legacy `media/*` wire names to the media plugin.

The shell backend still imports this module for its side effect -- registering
the media methods -- and the media tests still import it directly. Until the app
switches to the host, this loads the plugin through the same loader the host
uses and exposes its handlers under both the internal short names and the legacy
names the renderer keeps asking for.
"""

from __future__ import annotations

from pathlib import Path

from felyrics_host.loader import load_plugins
from felyrics_host.server import PLUGIN_METHODS

from felyrics_media import audio, image, video  # noqa: F401  (tests patch these)

_LEGACY_NAMES = {
    "probe": "media/probe",
    "decode": "media/decode",
    "video-probe": "video/probe",
    "video-frames": "video/frames",
}


def _register() -> None:
    repo = Path(__file__).resolve().parents[3]

    for plugin in load_plugins(
        [repo / "plugins" / "felyrics.media"], ["felyrics.media"]
    ):
        for name, handler in plugin.registry.handlers().items():
            PLUGIN_METHODS[name] = handler

            legacy = _LEGACY_NAMES.get(name)

            if legacy is not None:
                PLUGIN_METHODS[legacy] = handler


_register()
