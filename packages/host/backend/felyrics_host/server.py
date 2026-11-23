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

from .errors import ServiceError

Handler = Callable[[dict[str, Any]], Any]

METHODS: dict[str, Handler] = {}

# Both sides state the version they speak, and each one answers in its own: an
# implementation cannot reply in a format it does not know. The field is what
# catches a backend process left running from an older checkout, which the files
# on disk cannot reveal.
PROTOCOL_VERSION = 1


class ProtocolError(ServiceError):
    """A request that cannot be answered as asked; the client sees `code`."""


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

    version = request.get("v")

    # `bool` is a subclass of `int` in Python, so `True == 1` would pass a plain
    # equality test -- and the TypeScript client compares with `!==`, where a
    # boolean is never 1. Both sides must reject the same bytes.
    if (
        isinstance(version, bool)
        or not isinstance(version, int)
        or version != PROTOCOL_VERSION
    ):
        # `repr(None)` would read as the word None; a missing field is its own
        # case, because "forgot to send it" and "sent the wrong one" are what a
        # developer has to tell apart.
        declared = "none" if version is None else repr(version)

        raise ProtocolError(
            "protocol/version-mismatch",
            f"this backend speaks protocol version {PROTOCOL_VERSION}, "
            f"the request declared {declared}",
            data={"declared": version, "expected": PROTOCOL_VERSION},
        )

    # The id comes before the method: an answer nobody can match to a request is
    # worse than a refusal, and `respond` can only echo what it can type-check.
    request_id = request.get("id")

    if isinstance(request_id, bool) or not isinstance(request_id, int):
        raise ProtocolError(
            "protocol/invalid-request", "request.id must be an integer"
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

            # Echo only an id that could have been sent. A client that sends an
            # object cannot be correlated, and echoing it back invites the rest
            # of the system to trust a field the protocol never defined.
            if isinstance(request_id, bool) or not isinstance(request_id, int):
                request_id = None

        return {"v": PROTOCOL_VERSION, "id": request_id, "result": dispatch(request)}
    except json.JSONDecodeError as error:
        return {
            "v": PROTOCOL_VERSION,
            "id": None,
            "error": {
                "code": "protocol/invalid-json",
                "message": f"line is not JSON: {error}",
            },
        }
    except ServiceError as error:
        failure: dict[str, Any] = {"code": error.code, "message": error.message}

        # `data` is open on the wire on purpose: a new error that has something
        # renderable to say does not need a protocol change. The client keeps its
        # own context closed, so an unknown key costs nothing.
        if error.data is not None:
            failure["data"] = error.data

        return {"v": PROTOCOL_VERSION, "id": request_id, "error": failure}
    except Exception:
        # One broken handler must not kill a session that runs for hours.
        traceback.print_exc(file=sys.stderr)
        return {
            "v": PROTOCOL_VERSION,
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
