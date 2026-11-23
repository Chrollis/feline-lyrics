"""Loads a plugin's Python half: manifest first, then code.

Order matters. `load_manifest` runs before `importlib`, so an invalid manifest
never executes plugin code -- the invariant the contract states and the tests
pin with a marker file. `serve(ctx)` gets a registry that closes as soon as it
returns; the comparison against `contributes.internal` happens after that, so a
plugin that registers a method it did not declare is caught before the host
accepts a single request.
"""

from __future__ import annotations

import importlib
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .ctx import BackendContext
from .manifest import PluginError, PluginManifest, load_manifest
from .registry import Registry


@dataclass(frozen=True, slots=True)
class LoadedPlugin:
    """A plugin whose manifest and registrations agree."""

    manifest: PluginManifest
    registry: Registry


def load_plugin(directory: Path) -> LoadedPlugin:
    """Validates and activates one plugin directory."""

    return activate(load_manifest(directory))


def load_plugins(
    directories: Sequence[Path], requested: Sequence[str]
) -> list[LoadedPlugin]:
    """Loads the plugin directories, optionally limited to `requested` ids.

    Every manifest is validated before any plugin code runs, so a broken second
    plugin cannot leave the first one half-activated.
    """

    manifests = [load_manifest(directory) for directory in directories]
    by_id: dict[str, PluginManifest] = {}

    for manifest in manifests:
        previous = by_id.get(manifest.id)

        if previous is not None:
            raise PluginError(
                "core/duplicate-id",
                f"plugin {manifest.id!r} appears twice",
                issues=[
                    {"path": str(previous.directory)},
                    {"path": str(manifest.directory)},
                ],
            )

        by_id[manifest.id] = manifest

    if requested:
        missing = [
            plugin_id for plugin_id in requested if plugin_id not in by_id
        ]

        if missing:
            raise PluginError(
                "core/backend-failed",
                f"requested plugin(s) not found: {', '.join(missing)}",
                issues=[
                    {"path": "--plugin", "message": plugin_id}
                    for plugin_id in missing
                ],
            )

        selected = [by_id[plugin_id] for plugin_id in requested]
    else:
        selected = manifests

    return [activate(manifest) for manifest in selected]


def activate(manifest: PluginManifest) -> LoadedPlugin:
    """Runs `serve(ctx)` (when declared) and checks the registrations."""

    registry = Registry(manifest.id)

    if manifest.python is not None:
        _call_serve(manifest, registry)

    registry.freeze()
    issues = registry.mismatches(manifest.internal)

    if issues:
        raise PluginError(
            "core/methods-mismatch",
            f"plugin {manifest.id!r} registered methods that do not match "
            "its manifest",
            issues=issues,
        )

    return LoadedPlugin(manifest=manifest, registry=registry)


def _call_serve(manifest: PluginManifest, registry: Registry) -> None:
    backend = manifest.directory / "backend"

    if not backend.is_dir():
        raise PluginError(
            "core/backend-failed",
            f"plugin {manifest.id!r} declares a python backend but has no "
            "backend/ directory",
            issues=[
                {
                    "path": "felyrics.backend.python",
                    "message": str(backend),
                }
            ],
        )

    # The backend directory is what the plugin's module path is rooted at;
    # the host puts it there instead of asking the plugin to install itself.
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))

    module_name, _, attribute = manifest.python.partition(":")

    try:
        module = importlib.import_module(module_name)
    except Exception as error:
        raise PluginError(
            "core/backend-failed",
            f"plugin {manifest.id!r}: cannot import {module_name!r}: {error}",
            issues=[
                {
                    "path": "felyrics.backend.python",
                    "message": str(error),
                }
            ],
        ) from error

    serve = getattr(module, attribute, None)

    if not callable(serve):
        raise PluginError(
            "core/backend-failed",
            f"plugin {manifest.id!r}: {manifest.python!r} is not callable",
            issues=[
                {
                    "path": "felyrics.backend.python",
                    "message": f"{attribute!r} is not a function",
                }
            ],
        )

    try:
        serve(
            BackendContext(
                manifest.id,
                manifest.api,
                manifest.jobs,
                registry,
            )
        )
    except PluginError:
        raise
    except Exception as error:
        raise PluginError(
            "core/backend-failed",
            f"plugin {manifest.id!r}: serve() raised: {error}",
            issues=[
                {
                    "path": "felyrics.backend.python",
                    "message": str(error),
                }
            ],
        ) from error
