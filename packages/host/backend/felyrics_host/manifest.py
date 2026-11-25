"""The plugin manifest, validated before a single line of plugin code runs.

The rules are the ones in `reference/ideas/plugin-api-draft.md` section 3: the
package.json is the only manifest, unknown keys inside `felyrics` are refused,
and every problem is collected into one `PluginError` with a `path` per issue,
so an author fixes one list instead of one error per run.

Nothing here imports plugin code or calls `serve`; `loader.py` owns that next
step. Manifest validation is the gate that keeps a broken manifest from ever
reaching the import statement.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import ServiceError

SUPPORTED_API = 1
HOSTS = ("renderer", "utility")
WORKER_LIMIT = 8

_SHORT = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_TARGET = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_]*\Z")
_SEMVER = re.compile(
    r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\Z"
)
_ENGINE = re.compile(r"(>=|<=|==|>|<)(\d+)\.(\d+)\Z")

_FELYRICS_KEYS = frozenset(
    {"api", "host", "backend", "engines", "workers", "contributes"}
)
_BACKEND_KEYS = frozenset({"python", "exec"})
_CONTRIBUTES_KEYS = frozenset({"methods", "internal", "errors", "jobs"})

Issue = dict[str, str]


def is_short_name(name: Any) -> bool:
    """The one spelling rule for ids, method names, jobs and workers."""

    return isinstance(name, str) and _SHORT.match(name) is not None


class PluginError(ServiceError):
    """A plugin cannot be loaded; `issues` names every field that is wrong."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        issues: list[Issue] | None = None,
    ) -> None:
        self.issues = list(issues or [])
        super().__init__(
            code,
            message,
            data={"issues": self.issues} if issues is not None else None,
        )


@dataclass(frozen=True, slots=True)
class PluginManifest:
    """Everything the host needs from package.json, already validated."""

    id: str
    directory: Path
    api: int
    host: str
    python: str | None
    engines_python: str | None
    methods: tuple[str, ...]
    internal: tuple[str, ...]
    errors: tuple[str, ...]
    jobs: tuple[str, ...]


def load_manifest(directory: Path) -> PluginManifest:
    """Reads and validates `<directory>/package.json`; raises `PluginError`."""

    directory = Path(directory).expanduser().resolve()
    issues: list[Issue] = []

    package = _read_package(directory, issues)
    if issues:
        raise _invalid(issues)

    felyrics = package.get("felyrics")
    if not isinstance(felyrics, dict):
        _issue(issues, "felyrics", "must be an object")
        raise _invalid(issues)

    _refuse_unknown(felyrics, _FELYRICS_KEYS, "felyrics", issues)

    name = _text(package.get("name"), "name", issues)
    publisher = _text(package.get("publisher"), "publisher", issues, required=False)
    plugin_id = _derive_id(name, publisher, issues) if name is not None else None

    version = _text(package.get("version"), "version", issues)
    if version is not None and not _SEMVER.match(version):
        _issue(issues, "version", "must be semver, for example 0.1.0")

    _text(package.get("author"), "author", issues)
    _relative(package.get("main"), "main", issues)
    _relative(package.get("types"), "types", issues, required=False)

    api_value = felyrics.get("api")
    api: int | None = None
    if isinstance(api_value, bool) or not isinstance(api_value, int):
        _issue(issues, "felyrics.api", "must be an integer")
    else:
        api = api_value

    host = felyrics.get("host")
    if not isinstance(host, str) or host not in HOSTS:
        _issue(
            issues,
            "felyrics.host",
            f"must be one of {', '.join(HOSTS)}",
        )

    backend = felyrics.get("backend")
    backend_label: str | None = None
    python_target: str | None = None

    if backend is not None:
        if not isinstance(backend, dict):
            _issue(issues, "felyrics.backend", "must be an object")
        else:
            _refuse_unknown(backend, _BACKEND_KEYS, "felyrics.backend", issues)

            if "exec" in backend:
                _issue(
                    issues,
                    "felyrics.backend.exec",
                    "is not a backend in v0; start a helper from the python backend",
                )

            if "python" in backend:
                backend_label = "python"
                python_target = _text(
                    backend["python"], "felyrics.backend.python", issues
                )
                if python_target is not None and not _TARGET.match(
                    python_target
                ):
                    _issue(
                        issues,
                        "felyrics.backend.python",
                        "must be 'module:callable'",
                    )

    engines = felyrics.get("engines")
    engines_python: str | None = None

    if backend_label == "python":
        if not isinstance(engines, dict):
            _issue(issues, "felyrics.engines", "is required with a python backend")
        else:
            _refuse_unknown(engines, {"python"}, "felyrics.engines", issues)
            spec = _text(engines.get("python"), "felyrics.engines.python", issues)

            if spec is not None:
                if not all(_ENGINE.match(part.strip()) for part in spec.split(",")):
                    _issue(
                        issues,
                        "felyrics.engines.python",
                        "must be a comma separated list like >=3.12",
                    )
                else:
                    engines_python = spec
    elif engines is not None:
        _issue(
            issues,
            "felyrics.engines",
            "is only allowed with a python backend",
        )

    workers = felyrics.get("workers")

    if workers is not None:
        if not isinstance(workers, dict):
            _issue(issues, "felyrics.workers", "must be an object")
        else:
            if len(workers) > WORKER_LIMIT:
                _issue(
                    issues,
                    "felyrics.workers",
                    f"at most {WORKER_LIMIT} workers per plugin",
                )

            for worker_name, entry in workers.items():
                path = f"felyrics.workers.{worker_name}"

                if not is_short_name(worker_name):
                    _issue(issues, path, "must be lowercase kebab")
                else:
                    _relative(entry, path, issues)

    contributes = felyrics.get("contributes")
    methods: tuple[str, ...] = ()
    internal: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()
    jobs: tuple[str, ...] = ()

    if not isinstance(contributes, dict):
        _issue(
            issues,
            "felyrics.contributes",
            "is required and must be an object",
        )
    else:
        _refuse_unknown(
            contributes, _CONTRIBUTES_KEYS, "felyrics.contributes", issues
        )
        methods = _short_list(
            contributes,
            "methods",
            "felyrics.contributes.methods",
            issues,
            required=True,
            non_empty=True,
        )
        internal = _short_list(
            contributes,
            "internal",
            "felyrics.contributes.internal",
            issues,
            required=backend_label is not None,
            forbidden=backend_label is None,
        )
        errors = _short_list(
            contributes,
            "errors",
            "felyrics.contributes.errors",
            issues,
            required=False,
        )
        jobs = _short_list(
            contributes,
            "jobs",
            "felyrics.contributes.jobs",
            issues,
            required=False,
        )

    if issues:
        raise _invalid(issues)

    assert plugin_id is not None
    assert api is not None
    assert isinstance(host, str)

    if directory.name != plugin_id:
        raise PluginError(
            "core/identity-mismatch",
            f"directory {directory.name!r} does not hold plugin {plugin_id!r}",
            issues=[
                {
                    "path": "directory",
                    "message": f"expected {plugin_id!r}, found {directory.name!r}",
                }
            ],
        )

    if api != SUPPORTED_API:
        raise PluginError(
            "core/api-unsupported",
            f"plugin {plugin_id!r} declares api {api}; this host supports "
            f"{SUPPORTED_API}",
            issues=[
                {
                    "path": "felyrics.api",
                    "message": f"{api} is not in the supported set "
                    f"{{{SUPPORTED_API}}}",
                }
            ],
        )

    if engines_python is not None and not _satisfies_engine(engines_python):
        raise PluginError(
            "core/engine-unsatisfied",
            f"plugin {plugin_id!r} needs python {engines_python}; this process "
            f"is {sys.version_info.major}.{sys.version_info.minor}",
            issues=[
                {
                    "path": "felyrics.engines.python",
                    "message": engines_python,
                }
            ],
        )

    return PluginManifest(
        id=plugin_id,
        directory=directory,
        api=api,
        host=host,
        python=python_target,
        engines_python=engines_python,
        methods=methods,
        internal=internal,
        errors=errors,
        jobs=jobs,
    )


def _read_package(directory: Path, issues: list[Issue]) -> dict[str, Any]:
    path = directory / "package.json"

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        _issue(issues, "package.json", f"cannot read: {error}")
        return {}

    try:
        package = json.loads(text)
    except json.JSONDecodeError as error:
        _issue(issues, "package.json", f"is not JSON: {error}")
        return {}

    if not isinstance(package, dict):
        _issue(issues, "package.json", "must contain a JSON object")
        return {}

    return package


def _derive_id(
    name: str, publisher: str | None, issues: list[Issue]
) -> str | None:
    if name.startswith("@"):
        scope, slash, short = name[1:].partition("/")

        if not slash or not scope or not short:
            _issue(issues, "name", "a scoped name is written @scope/name")
            return None

        if not _SHORT.match(scope) or not _SHORT.match(short):
            _issue(issues, "name", "each segment must be lowercase kebab")
            return None

        if publisher is not None:
            _issue(issues, "publisher", "a scoped name must not declare publisher")

        return f"{scope}.{short}"

    if not _SHORT.match(name):
        _issue(issues, "name", "must be lowercase kebab")
        return None

    if publisher is None:
        _issue(issues, "publisher", "a plain name requires publisher")
        return None

    if not _SHORT.match(publisher):
        _issue(issues, "publisher", "must be lowercase kebab")
        return None

    return f"{publisher}.{name}"


def _satisfies_engine(spec: str) -> bool:
    current = (sys.version_info.major, sys.version_info.minor)

    for clause in spec.split(","):
        match = _ENGINE.match(clause.strip())

        if match is None:
            return False

        op, major, minor = match.groups()
        target = (int(major), int(minor))
        accepted = {
            ">=": current >= target,
            "<=": current <= target,
            ">": current > target,
            "<": current < target,
            "==": current == target,
        }[op]

        if not accepted:
            return False

    return True


def _text(
    value: Any,
    path: str,
    issues: list[Issue],
    *,
    required: bool = True,
) -> str | None:
    if value is None:
        if required:
            _issue(issues, path, "is required")
        return None

    if not isinstance(value, str) or not value:
        _issue(issues, path, "must be a non-empty string")
        return None

    return value


def _relative(
    value: Any,
    path: str,
    issues: list[Issue],
    *,
    required: bool = True,
) -> str | None:
    text = _text(value, path, issues, required=required)

    if text is None:
        return None

    candidate = Path(text)

    if candidate.is_absolute() or ".." in candidate.parts:
        _issue(issues, path, "must stay inside the package")
        return None

    return text


def _short_list(
    container: dict[str, Any],
    key: str,
    path: str,
    issues: list[Issue],
    *,
    required: bool,
    non_empty: bool = False,
    forbidden: bool = False,
) -> tuple[str, ...]:
    if key not in container:
        if required:
            _issue(issues, path, "is required")
        return ()

    if forbidden:
        _issue(issues, path, "is not allowed without a backend")
        return ()

    value = container[key]

    if not isinstance(value, list):
        _issue(issues, path, "must be an array of names")
        return ()

    names: list[str] = []

    for index, item in enumerate(value):
        if not is_short_name(item):
            _issue(issues, f"{path}[{index}]", "must be lowercase kebab")
        elif item in names:
            _issue(issues, f"{path}[{index}]", f"{item!r} is listed twice")
        else:
            names.append(item)

    if non_empty and not names:
        _issue(issues, path, "must declare at least one name")

    return tuple(names)


def _refuse_unknown(
    container: dict[str, Any],
    allowed: frozenset[str],
    path: str,
    issues: list[Issue],
) -> None:
    for key in container:
        if key not in allowed:
            _issue(
                issues,
                f"{path}.{key}",
                f"unknown key; allowed: {', '.join(sorted(allowed))}",
            )


def _issue(issues: list[Issue], path: str, message: str) -> None:
    issues.append({"path": path, "message": message})


def _invalid(issues: list[Issue]) -> PluginError:
    return PluginError(
        "core/manifest-invalid",
        f"the manifest has {len(issues)} problem(s)",
        issues=issues,
    )
