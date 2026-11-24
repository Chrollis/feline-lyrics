import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { JOB_ID, JOB_ORIGIN, resolveJobFile } from '../dist/index.js';

const jobsRoot = join(resolve('.'), 'cache', 'jobs');
const job = 'a'.repeat(32);

test('serves one file inside one job directory', () => {
  // The shape the host actually writes: a job id, then the file.
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${job}/0001.png`),
    join(jobsRoot, job, '0001.png'),
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${job}/audio.flac`),
    join(jobsRoot, job, 'audio.flac'),
  );
});

test('refuses anything that is not one job and one file', () => {
  assert.equal(resolveJobFile(jobsRoot, `${JOB_ORIGIN}/`), null);
  assert.equal(resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${job}`), null);
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${job}/nested/0001.png`),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/not-a-job-id/0001.png`),
    null,
  );
  // The old kind bucket is now a job id nobody wrote, not a directory to serve.
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/frames/${job}/0001.png`),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${job}/..%5csecret.txt`),
    null,
  );
  assert.equal(resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${job}/%zz.png`), null);
});

test('does not accept another host or scheme', () => {
  assert.equal(
    resolveJobFile(jobsRoot, `app://bundle/${job}/0001.png`),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `https://job/${job}/0001.png`),
    null,
  );
  assert.equal(resolveJobFile(jobsRoot, 'not a url'), null);
});

test('the job id shape is what the backend writes', () => {
  assert.equal(JOB_ID.test(job), true);
  assert.equal(JOB_ID.test('A'.repeat(32)), false);
  assert.equal(JOB_ID.test(job.slice(1)), false);
});
