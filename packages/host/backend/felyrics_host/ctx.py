"""The object a plugin's `serve()` receives.

It is deliberately narrow: the plugin learns its identity, the api it was
written against, and the one way to register a method. Everything else --
the process, stdio, the protocol envelope -- stays with the host, so a plugin
cannot write a read loop or invent a second registry.
"""

from __future__ import annotations

from .registry import Handler, Registry


class BackendContext:
    """The plugin's view of the host backend; attributes are read-only."""

    def __init__(self, plugin_id: str, api: int, registry: Registry) -> None:
        self._plugin_id = plugin_id
        self._api = api
        self._registry = registry

    @property
    def plugin_id(self) -> str:
        """The derived id, for example `felyrics.media`."""

        return self._plugin_id

    @property
    def api(self) -> int:
        """The `felyrics.api` the plugin declared."""

        return self._api

    def method(self, name: str, handler: Handler) -> None:
        """Registers an internal method; only valid during `serve()`."""

        self._registry.register(name, handler)
