"""The felyrics backend: one long-lived process speaking JSON lines on stdio.

This package is a shell over `felyrics_host`, which lives in
`packages/host/backend`. The venv's `.pth` still points only at `services/`, so
until provisioning writes the host path there, the shell resolves it from the
checkout. Delete this package when `services/` retires.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    import felyrics_host  # noqa: F401
except ModuleNotFoundError:
    _checkout = Path(__file__).resolve().parents[2]
    _host_backend = _checkout / "packages" / "host" / "backend"

    sys.path.insert(0, str(_host_backend))

    import felyrics_host  # noqa: F401
