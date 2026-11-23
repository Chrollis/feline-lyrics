"""The object a plugin's `serve()` receives.

It is deliberately narrow: the plugin learns its identity, the api it was
written against, and the one way to register a method. Everything else --
the process, stdio, the protocol envelope -- stays with the host, so a plugin
cannot write a read loop or invent a second registry.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from . import runtime
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

    def new_job(self, kind: str) -> Path:
        """Creates an empty job directory and returns its absolute path.

        The host owns the layout; a plugin names the result kind, never a path,
        so the cache shape can change without every plugin agreeing on it. The
        previous job of the same kind is left in place until the plugin's result
        is complete, because the renderer may still be reading it.

        The plugin-scoped bucket arrives with the job URL switch; until then the
        old three-segment shape keeps the renderer's URLs working.
        """

        directory = runtime.cache_root() / "jobs" / kind / uuid.uuid4().hex
        directory.mkdir(parents=True, exist_ok=True)

        return directory
