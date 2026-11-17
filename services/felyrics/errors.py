"""The error type the backend raises for a caller's problem.

Codes follow `domain/reason`. The protocol layer turns any `ServiceError` into
`{"code", "message"}`, so a caller can branch on `media/no-audio-stream`
without matching on an exception class from libav, and a handler can refuse a
request without the failure being reported as `internal/error`.
"""

from __future__ import annotations


class ServiceError(Exception):
    """A failure the caller can act on; `code` is stable, `message` is for humans."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
