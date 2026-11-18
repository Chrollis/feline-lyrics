"""The error type the backend raises for a caller's problem.

Codes follow `domain/reason`. The protocol layer turns any `ServiceError` into
`{"code", "message"}` plus an optional `data`, so a caller can branch on
`media/no-audio-stream` without matching on an exception class from libav, and a
handler can refuse a request without the failure being reported as `internal/error`.

`message` is English fallback text. Anything a client is expected to *render*
belongs in `data` as a field, because a sentence stops being parseable the moment
someone translates it.
"""

from __future__ import annotations

from typing import Any


class ServiceError(Exception):
    """A failure the caller can act on; `code` is stable, `message` is for humans."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        data: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data
