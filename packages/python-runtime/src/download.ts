import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DownloadOptions {
  readonly url: string;
  readonly dest: string;
  readonly fetchImpl?: typeof fetch;
  readonly attempts?: number;
  readonly minBytes?: number;
  readonly onProgress?: (received: number, total: number | null) => void;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MIN_BYTES = 1024;

export async function download(options: DownloadOptions): Promise<number> {
  const {
    url,
    dest,
    fetchImpl = fetch,
    attempts = DEFAULT_ATTEMPTS,
    minBytes = DEFAULT_MIN_BYTES,
    onProgress,
  } = options;

  await mkdir(dirname(dest), { recursive: true });

  const part = `${dest}.part`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      if (!response.body) {
        throw new Error(`empty response body for ${url}`);
      }

      const total = Number(response.headers.get('content-length')) || 0;
      const handle = await open(part, 'w');
      let received = 0;

      try {
        const reader = response.body.getReader();

        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          received += value.byteLength;
          await handle.write(value);
          onProgress?.(received, total > 0 ? total : null);
        }
      } finally {
        await handle.close();
      }

      if (total > 0 && received !== total) {
        throw new Error(
          `truncated download: received ${received} of ${total} bytes`,
        );
      }
      if (total === 0 && received < minBytes) {
        throw new Error(
          `truncated download: received ${received} bytes, below the ${minBytes}-byte floor`,
        );
      }

      await rename(part, dest);

      return received;
    } catch (error) {
      lastError = error;
      await rm(part, { force: true });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
