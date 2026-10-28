// tsc never removes output for a source file that was renamed or deleted, so a
// stale `out/` can carry modules that no longer exist. Wipe it before building.
import { rm } from 'node:fs/promises';

await rm(new URL('../out', import.meta.url), { recursive: true, force: true });
