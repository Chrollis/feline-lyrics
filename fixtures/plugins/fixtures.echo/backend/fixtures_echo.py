def serve(ctx):
    """Echo the params back; the shape is the contract, not the value."""

    return ctx.method("echo", lambda params: {"echo": params})
