// uv brings its own Python build, so no system Python takes part.
// The NJU mirror carries python-build-standalone only; uv is a separate host.
export const UV_VERSION = '0.13.8';
export const UV_FILENAME = 'uv-x86_64-pc-windows-msvc.zip';
export const UV_DOWNLOAD_URL = `https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/${UV_FILENAME}`;

export const PYTHON_VERSION = '3.12.15';

export const PACKAGE_INDEX_URL = 'https://mirrors.cloud.tencent.com/pypi/simple/';

export const MIN_DOWNLOAD_BYTES = 1024 ** 2;
