"""Media primitives: decode, re-encode, and hand the result to the caller.

One module per medium. Every failure is raised as `ServiceError` with a code
under the plugin's own prefix (`felyrics.media/...`) instead of leaking libav
exceptions across the protocol boundary.
"""
