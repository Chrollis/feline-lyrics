# Toolchain

`@felyrics/toolchain` installs the Python backend and speaks to it. It answers two
questions and nothing else:

1. **Should the backend be built, or rebuilt?** — `provision()`
2. **Is the backend on disk usable right now?** — `doctor()`

Everything else belongs to a caller: the CLI (`scripts/python.mjs`), the Electron
main process (`apps/desktop/src/main/`), or the backend itself (`services/felyrics/`).

## Scope

| In scope | Out of scope |
| --- | --- |
| Downloading and unpacking `uv` | What a song is, or how lyrics are modelled |
| Installing the pinned CPython and rebuilding the venv | Audio or video encoding decisions |
| Writing the `.pth` file and installing requirements | The renderer, or which panel shows what |
| The JSON-lines protocol client | The backend's own methods |
| Reporting why a backend is not usable | Picking directories for the user |

## Quick start

```bash
npm run build                     # packages/toolchain/out must exist first
npm run python -- --setup         # install: uv, CPython 3.12.15, venv, requirements
npm run python -- --doctor        # read-only check, one line per check
```

`--setup` is safe to repeat. The second run short-circuits on the `.ready` marker;
a changed `services/requirements.txt` invalidates that marker and rebuilds.

`--doctor` writes nothing. It exits non-zero when any check fails.

## Document map

| Document | Answers |
| --- | --- |
| [reference.md](reference.md) | What exists: public functions, constants, error codes, on-disk layout, CLI |
| [provisioning.md](provisioning.md) | How one setup run works, why the steps are in that order, what is reused |
| [protocol.md](protocol.md) | The wire format, the client's deadline and failure behaviour, result files |

## Module map

| Directory | Contents |
| --- | --- |
| `src/layout/` | Path derivation (`paths.ts`), child-process environment (`env.ts`), scratch directory (`temp.ts`) |
| `src/process/` | Zip reading and unpacking, with entry-name validation (`zip.ts`) |
| `src/python/` | Platform table and pins (`target.ts`), `download.ts`, `uv.ts`, `ready.ts`, `pth.ts`, `requirements.ts`, `provision.ts`, `doctor.ts`, `service.ts` |
| `src/errors.ts` | `ToolchainError` and its closed code list |
| `src/index.ts` | The only public entry point; import from here, not from `src/` internals |

## Inputs

The toolchain never invents a directory. It takes exactly three and derives the rest:

| Field | Meaning | Supplied by |
| --- | --- | --- |
| `cacheDir` | Shared download and tool cache | CLI: `cache/`; packaged app: `userData/cache` |
| `servicesDir` | Backend sources, read-only | Repo: `services/`; packaged app: `resources/services` |
| `backendRoot` | The backend's own home: `uv`, interpreter, venv, marker | Repo: `python/`; packaged app: `userData/backend` |

`backendRoot` may be moved, but moving it is equivalent to a rebuild: the venv records
absolute paths. This is intentional; `.ready` and `--doctor` exist to notice it.

## Supported platforms

`win32-x64` only. The platform table carries six rows so a port starts with the asset
names rather than with a search, but `SUPPORTED_TARGETS` names the one row that runs;
`currentTarget()` throws `target/unsupported` for every other key. `tar.gz` uv archives
are likewise unsupported — `extractZip` reads zip only.

## Suggested reading order

`layout/paths.ts` → `python/ready.ts` (what "ready" means) → `python/provision.ts`
(the only assembly entry point) → `python/uv.ts` and `python/download.ts` (the actual
work) → `python/doctor.ts`. For the wire side start at `python/service.ts` together
with [protocol.md](protocol.md).
