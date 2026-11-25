import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  JOB_ID,
  JOB_ORIGIN,
  PLUGIN_ID,
  resolveJobFile,
} from '../dist/index.js';

const jobsRoot = join(resolve('.'), 'cache', 'jobs');
const plugin = 'felyrics.media';
const job = 'a'.repeat(32);
const pluginIds = new Set([plugin, 'someone.echo']);

test('serves one file inside one plugin job directory', () => {
  // The shape the host actually writes: a plugin id, a job id, then the file.
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${plugin}/${job}/0001.png`, pluginIds),
    join(jobsRoot, plugin, job, '0001.png'),
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${plugin}/${job}/audio.flac`, pluginIds),
    join(jobsRoot, plugin, job, 'audio.flac'),
  );
});

test('refuses anything that is not one plugin, one job and one file', () => {
  assert.equal(resolveJobFile(jobsRoot, `${JOB_ORIGIN}/`, pluginIds), null);
  assert.equal(resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${job}`, pluginIds), null);
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${plugin}/${job}`, pluginIds),
    null,
  );
  assert.equal(
    resolveJobFile(
      jobsRoot,
      `${JOB_ORIGIN}/${plugin}/${job}/nested/0001.png`,
      pluginIds,
    ),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/not-a-plugin/${job}/0001.png`, pluginIds),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/not-a-job-id/${job}/0001.png`, pluginIds),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${plugin}/not-a-job/0001.png`, pluginIds),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${plugin}/${job}/..%5csecret.txt`, pluginIds),
    null,
  );
  // The host writes `.kind` beside the results; it is not a served file.
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${plugin}/${job}/.kind`, pluginIds),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${plugin}/${job}/.hidden.png`, pluginIds),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/${plugin}/${job}/%zz.png`, pluginIds),
    null,
  );
});

test('refuses a plugin the app has not discovered', () => {
  assert.equal(
    resolveJobFile(jobsRoot, `${JOB_ORIGIN}/other.plugin/${job}/0001.png`, pluginIds),
    null,
  );
});

test('does not accept another host or scheme', () => {
  assert.equal(
    resolveJobFile(jobsRoot, `app://bundle/${plugin}/${job}/0001.png`, pluginIds),
    null,
  );
  assert.equal(
    resolveJobFile(jobsRoot, `https://job/${plugin}/${job}/0001.png`, pluginIds),
    null,
  );
  assert.equal(resolveJobFile(jobsRoot, 'not a url', pluginIds), null);
});

test('the shapes are what the backend writes', () => {
  assert.equal(JOB_ID.test(job), true);
  assert.equal(JOB_ID.test('A'.repeat(32)), false);
  assert.equal(JOB_ID.test(job.slice(1)), false);
  assert.equal(PLUGIN_ID.test(plugin), true);
  assert.equal(PLUGIN_ID.test('someone.echo'), true);
  assert.equal(PLUGIN_ID.test('not a plugin'), false);
});
