"""The methods one plugin registers, frozen when its `serve()` returns.

The registry is per plugin: internal names are plugin-local, and the host adds
the plugin id prefix wherever a name leaves the plugin. Registration happens
only while `serve(ctx)` runs; `freeze()` closes the window and later calls are a
programming error, not a new method.

`mismatches()` performs the comparison the manifest gate is built on: every
registered name must be declared, and every declared name must be registered.
The host reports the differences as `issues[]` instead of guessing which side is
wrong.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from types import MappingProxyType
from typing import Any, Callable

from .manifest import PluginError, is_short_name

Handler = Callable[[dict[str, Any]], Any]


class Registry:
    """One plugin's method table, plus the comparison with its manifest."""

    def __init__(self, plugin_id: str) -> None:
        self.plugin_id = plugin_id
        self._handlers: dict[str, Handler] = {}
        self._frozen = False

    @property
    def frozen(self) -> bool:
        return self._frozen

    def register(self, name: Any, handler: Handler) -> None:
        """Adds a method; only valid while the registration window is open."""

        if self._frozen:
            raise _mismatch(
                self.plugin_id,
                name,
                "was registered after serve() returned",
            )

        if not is_short_name(name):
            raise _mismatch(
                self.plugin_id,
                name,
                "must be lowercase kebab",
            )

        if name in self._handlers:
            raise _mismatch(
                self.plugin_id,
                name,
                "was registered twice",
            )

        if not callable(handler):
            raise _mismatch(
                self.plugin_id,
                name,
                "is not callable",
            )

        self._handlers[name] = handler

    def freeze(self) -> None:
        """Closes the registration window for this plugin."""

        self._frozen = True

    def handlers(self) -> Mapping[str, Handler]:
        """A read-only view of the methods registered so far."""

        return MappingProxyType(self._handlers)

    def mismatches(self, declared: Sequence[str]) -> list[dict[str, str]]:
        """Every name that is declared without a handler, or the reverse."""

        issues: list[dict[str, str]] = []

        for index, name in enumerate(declared):
            if name not in self._handlers:
                issues.append(
                    {
                        "path": f"contributes.internal[{index}]",
                        "message": f"{name!r} is declared but was not registered",
                    }
                )

        declared_names = set(declared)

        for name in self._handlers:
            if name not in declared_names:
                issues.append(
                    {
                        "path": "contributes.internal",
                        "message": f"{name!r} was registered but is not declared",
                    }
                )

        return issues


def _mismatch(plugin_id: str, name: Any, reason: str) -> PluginError:
    return PluginError(
        "core/methods-mismatch",
        f"plugin {plugin_id!r} cannot register method {name!r}: {reason}",
        issues=[
            {
                "path": "contributes.internal",
                "message": f"{name!r} {reason}",
            }
        ],
    )
