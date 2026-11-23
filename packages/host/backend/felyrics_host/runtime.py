"""Settings the process needs but the protocol does not carry.

Today there is exactly one: the directory the service may write job files to.
The process that starts the backend (the CLI, or Electron) decides it and passes
it on the command line, so nothing here is discovered from the environment and
two backends started by different callers cannot disagree about it.
"""

from __future__ import annotations

from pathlib import Path

_root: Path | None = None


def configure(cache_root: str | Path) -> None:
    """Fixes where job output goes. Called once, before the loop starts."""

    global _root

    _root = Path(cache_root).expanduser().resolve()


def cache_root() -> Path:
    """The configured cache directory. Missing means a programming error."""

    if _root is None:
        raise RuntimeError("the backend was started without a cache directory")

    return _root
