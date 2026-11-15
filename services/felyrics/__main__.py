"""Entry point: `python -m felyrics` speaks the JSON-lines protocol on stdio."""

from __future__ import annotations

import sys

from .server import serve


def main() -> int:
    # Windows consoles default to a legacy code page; the protocol is UTF-8 so
    # a lyric line survives the round trip.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    serve(sys.stdin, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
