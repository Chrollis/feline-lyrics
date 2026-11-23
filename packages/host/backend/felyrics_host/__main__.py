"""Entry point: `python -m felyrics_host --cache <dir> [plugin flags]`.

The cache directory is required for the same reason it was on the old backend:
a host that invents its own scratch directory writes files nobody will find
again, and the caller is the only party that knows where the app keeps its
state.

`--plugin-dir` takes a plugin package directory (the one holding package.json)
and may repeat; `--plugin` narrows the set to those ids. Scanning the two plugin
roots is the next step, so this one keeps the paths explicit.
"""

from __future__ import annotations

import argparse
import sys

from . import runtime
from .loader import load_plugins
from .manifest import PluginError
from .server import METHODS, PLUGIN_METHODS, serve


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="felyrics_host",
        description="plugin host, JSON lines over stdio",
    )
    parser.add_argument(
        "--cache",
        required=True,
        help="directory this process may write job files to",
    )
    parser.add_argument(
        "--plugin",
        action="append",
        default=[],
        metavar="ID",
        help="load only this plugin id; repeatable",
    )
    parser.add_argument(
        "--plugin-dir",
        action="append",
        default=[],
        metavar="DIR",
        help="plugin package directory (holds package.json); repeatable",
    )
    arguments = parser.parse_args(argv)

    runtime.configure(arguments.cache)

    try:
        loaded = load_plugins(
            arguments.plugin_dir, arguments.plugin
        )

        for plugin in loaded:
            for name, handler in plugin.registry.handlers().items():
                if name in METHODS or name in PLUGIN_METHODS:
                    raise PluginError(
                        "core/methods-mismatch",
                        f"method {name!r} from {plugin.manifest.id} is "
                        "already registered",
                        issues=[
                            {
                                "path": "contributes.internal",
                                "message": name,
                            }
                        ],
                    )

                PLUGIN_METHODS[name] = handler
    except PluginError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)

        for issue in error.issues:
            print(
                f"  {issue.get('path', '')}: {issue.get('message', '')}",
                file=sys.stderr,
            )

        return 1

    # Windows consoles default to a legacy code page; the protocol is UTF-8 so
    # a lyric line survives the round trip.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    serve(sys.stdin, sys.stdout)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
