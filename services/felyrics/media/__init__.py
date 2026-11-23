"""Temporary re-export package for the media code that now lives in the plugin.

The plugin's Python backend is importable from `plugins/felyrics.media/backend`;
this package keeps the old `felyrics.media.*` paths working until `services/`
retires, so the shell backend and its tests exercise the same implementation as
the host does.
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = (
    Path(__file__).resolve().parents[3] / "plugins" / "felyrics.media" / "backend"
)

if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))
