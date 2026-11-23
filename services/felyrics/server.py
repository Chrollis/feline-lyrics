"""Compatibility import for the host protocol module.

The protocol loop now lives in `felyrics_host.server`; this module forwards its
names until `services/` retires. The names are imports, not copies, so `method`
registers into the same `METHODS` dictionary the host serves from.
"""

from felyrics_host.server import (
    METHODS,
    PROTOCOL_VERSION,
    Handler,
    ProtocolError,
    dispatch,
    method,
    ping,
    respond,
    serve,
)
