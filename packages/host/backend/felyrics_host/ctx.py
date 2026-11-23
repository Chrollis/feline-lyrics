"""The object a plugin's `serve()` receives.

It is deliberately narrow: the plugin learns its identity, the api it was
written against, and the two things the host owns -- method registration and
job directories. Everything else -- the process, stdio, the protocol envelope --
stays with the host, so a plugin cannot write a read loop or invent a second
registry.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from urllib.parse import quote

from . import runtime
from .errors import ServiceError
from .registry import Handler, Registry

# The origin `jobUrl` mints. It is fixed until the app learns to configure it;
# plugins never see the cache path behind it.
JOB_SCHEME = "app://job"

# The metadata file `new_job` writes so the plugin can find the previous job of
# the same kind after the directories were flattened. It is not served: the URL
# resolver refuses dot files.
KIND_FILE = ".kind"


class BackendContext:
    """The plugin's view of the host backend; attributes are read-only."""

    def __init__(
        self,
        plugin_id: str,
        api: int,
        jobs: tuple[str, ...],
        registry: Registry,
    ) -> None:
        self._plugin_id = plugin_id
        self._api = api
        self._jobs = jobs
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
        previous job is left in place until the plugin's result is complete,
        because the renderer may still be reading it.

        Directories are flat under `<cache>/jobs/<hex>` so a URL needs one id
        and no plugin or kind segment. The per-plugin bucket and the host job
        table arrive with the loader's scan; the `.kind` marker is what keeps
        "drop the previous stills" working until then.
        """

        if kind not in self._jobs:
            raise ServiceError(
                "core/internal",
                f"{self._plugin_id} does not declare job kind {kind!r}",
            )

        directory = runtime.cache_root() / "jobs" / uuid.uuid4().hex
        directory.mkdir(parents=True, exist_ok=True)
        (directory / KIND_FILE).write_text(kind, encoding="utf-8")

        return directory

    def jobUrl(self, job: Path, file: str) -> str:
        """The URL a file inside `job` is reachable at.

        Spelling follows the plugin contract (`jobUrl`), not Python's usual
        snake_case: both languages name the same capability the same way.
        """

        return f"{JOB_SCHEME}/{job.name}/{quote(file)}"
