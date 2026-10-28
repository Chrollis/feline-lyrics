"""Entry point: bind loopback, announce the endpoint, serve until shutdown.

The handshake line on stdout is the only thing main reads from us
(docs/.be/api.md section 3); everything else goes to stderr.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import signal
import sys
import traceback

from .server import PROTOCOL, BackendService, run_service


def _emit_handshake(port: int, token: str) -> None:
    sys.stdout.write(
        json.dumps({"port": port, "token": token, "protocol": PROTOCOL}) + "\n"
    )
    sys.stdout.flush()


async def _serve(
    host: str, port: int, token: str, espeak_dir: str | None
) -> int:
    service = BackendService(token=token, espeak_dir=espeak_dir)
    server = await run_service(service, host, port)
    actual_port = server.sockets[0].getsockname()[1]
    _emit_handshake(actual_port, token)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, service.stopped.set)
        except (NotImplementedError, RuntimeError):
            try:
                signal.signal(sig, lambda *_: service.stopped.set())
            except (ValueError, OSError):
                pass

    await service.stopped.wait()
    service.log("stop", reason="shutdown")
    await service.aclose()
    server.close()
    await server.wait_closed()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="felyrics", add_help=False)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument(
        "--espeak-dir", default=os.environ.get("FELYRICS_ESPEAK_DIR") or None
    )
    args = parser.parse_args(argv)

    if sys.version_info[:2] != (3, 12):
        sys.stderr.write(
            f"felyrics needs Python 3.12, this is {sys.version.split()[0]}\n"
        )
        return 2

    token = secrets.token_hex(16)
    try:
        return asyncio.run(_serve(args.host, args.port, token, args.espeak_dir))
    except OSError as exc:
        sys.stderr.write(f"cannot bind {args.host}:{args.port}: {exc}\n")
        return 3
    except Exception:  # noqa: BLE001 - the parent reads the traceback from stderr
        traceback.print_exc(file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
