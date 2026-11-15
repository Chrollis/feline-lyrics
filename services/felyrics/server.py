"""JSON-lines protocol over stdio.

The rules are deliberately small: one JSON object per line in, one per line out,
and nothing else on stdout. Diagnostics go to stderr, because stdout is the
protocol channel and one stray print would desynchronise the client.
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import IO, Any, Callable

Handler = Callable[[dict[str, Any]], Any]

METHODS: dict[str, Handler] = {}


class ProtocolError(Exception):
    """A request that cannot be answered as asked; the client sees `code`."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def method(name: str) -> Callable[[Handler], Handler]:
    """Registers a handler under `name`; new features add methods this way."""

    def register(handler: Handler) -> Handler:
        METHODS[name] = handler
        return handler

    return register


@method("ping")
def ping(params: dict[str, Any]) -> dict[str, bool]:
    """The liveness probe: proving the loop reads and writes one line."""

    return {"pong": True}


def dispatch(request: Any) -> Any:
    """Validates one parsed request and returns the handler's result."""

    if not isinstance(request, dict):
        raise ProtocolError(
            "protocol/invalid-request", "request must be a JSON object"
        )

    name = request.get("method")

    if not isinstance(name, str):
        raise ProtocolError(
            "protocol/invalid-request", "request.method must be a string"
        )

    handler = METHODS.get(name)

    if handler is None:
        raise ProtocolError("method/not-found", f"no method named {name!r}")

    params = request.get("params", {})

    if not isinstance(params, dict):
        raise ProtocolError(
            "protocol/invalid-request", "request.params must be an object"
        )

    return handler(params)


def respond(line: str) -> dict[str, Any]:
    """Turns one input line into one response object, never raising."""

    request_id: Any = None

    try:
        request = json.loads(line)

        if isinstance(request, dict):
            request_id = request.get("id")

        return {"id": request_id, "result": dispatch(request)}
    except json.JSONDecodeError as error:
        return {
            "id": None,
            "error": {
                "code": "protocol/invalid-json",
                "message": f"line is not JSON: {error}",
            },
        }
    except ProtocolError as error:
        return {"id": request_id, "error": {"code": error.code, "message": error.message}}
    except Exception:
        # One broken handler must not kill a session that runs for hours.
        traceback.print_exc(file=sys.stderr)
        return {
            "id": request_id,
            "error": {
                "code": "internal/error",
                "message": "the handler raised; the traceback is on stderr",
            },
        }


def serve(stdin: IO[str], stdout: IO[str]) -> None:
    """The loop: read a line, answer a line, until stdin closes."""

    for raw in stdin:
        line = raw.strip()

        if not line:
            continue

        stdout.write(json.dumps(respond(line), ensure_ascii=False))
        stdout.write("\n")
        stdout.flush()
