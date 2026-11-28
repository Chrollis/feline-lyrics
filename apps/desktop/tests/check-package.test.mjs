import assert from 'node:assert/strict';
import test from 'node:test';

import { runSelfTest } from '../../../scripts/check-package.mjs';

function writerScript(text, code) {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `fs.writeFileSync(path.join(process.argv[1], 'result.txt'), ${JSON.stringify(text)}, 'utf8');`,
    `process.exit(${code});`,
  ].join(' ');
}

test(
  'reports the result a failed self-test wrote',
  { timeout: 15_000 },
  async () => {
    await assert.rejects(
      runSelfTest({
        exePath: process.execPath,
        timeoutMs: 10_000,
        selfTestArgs: (dir) => [
          '-e',
          writerScript('packaged koffi failed: injected failure', 1),
          dir,
        ],
      }),
      (error) => {
        assert.match(error.message, /exited with code 1/);
        assert.match(error.message, /injected failure/);

        return true;
      },
    );
  },
);

test(
  'returns the result a successful self-test wrote',
  { timeout: 15_000 },
  async () => {
    const result = await runSelfTest({
      exePath: process.execPath,
      timeoutMs: 10_000,
      selfTestArgs: (dir) => [
        '-e',
        writerScript('packaged koffi ok', 0),
        dir,
      ],
    });

    assert.equal(result, 'packaged koffi ok');
  },
);
