"""Media primitives: decode, re-encode, and hand the result to the caller.

One module per medium. Every failure is raised as `ServiceError` with a
`domain/reason` code instead of leaking libav exceptions across the protocol
boundary; the code always names the medium (`media/...`).
"""
