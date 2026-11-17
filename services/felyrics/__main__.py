"""Entry point: `python -m felyrics --cache <dir>` speaks the protocol on stdio.

The cache directory is required rather than defaulted: a backend that invents
its own scratch directory writes files nobody will ever find again, and the
caller (the CLI or Electron) is the only party that knows where the app keeps
its state.
"""

from __future__ import annotations

import argparse
import sys

from . import runtime
from .media import methods as _media_methods  # noqa: F401  (import registers them)
from .server import serve


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="felyrics", description="lyrics timing backend, JSON lines over stdio"
    )
    parser.add_argument(
        "--cache", required=True, help="directory this process may write job files to"
    )
    arguments = parser.parse_args(argv)

    runtime.configure(arguments.cache)

    # Windows consoles default to a legacy code page; the protocol is UTF-8 so
    # a lyric line survives the round trip.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    serve(sys.stdin, sys.stdout)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
