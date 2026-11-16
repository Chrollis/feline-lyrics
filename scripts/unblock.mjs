// Restores a normal Windows directory after a sandbox left it with a low
// mandatory label and an explicit deny ACE. Electron refuses to start on such a
// directory (exit code 0x80000003 with no output).
//
//   npm run unblock              apply the fix, then report the new state
//   npm run unblock -- --check   only report, change nothing
//   npm run unblock -- <dir>     fix another directory instead of the repo root
//
// The script is idempotent: on a clean tree it prints the state and exits 0.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argument = process.argv.slice(2).find((value) => !value.startsWith('--'));
const root = argument ? resolve(argument) : defaultRoot;
const checkOnly = process.argv.includes('--check');

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${file} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  return result.stdout;
}

function powershell(script) {
  return run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]).trim();
}

function quoted(path) {
  return path.replace(/'/g, "''");
}

function labelOf(path) {
  const text = run('icacls', [path]);

  if (/Low Mandatory Level/i.test(text)) {
    return 'low';
  }

  if (/Medium Mandatory Level/i.test(text)) {
    return 'medium';
  }

  if (/High Mandatory Level/i.test(text)) {
    return 'high';
  }

  return 'none';
}

function denyCount(path) {
  const script = `@(Get-Acl -LiteralPath '${quoted(path)}').Access | Where-Object { $_.AccessControlType -eq 'Deny' } | Measure-Object | Select-Object -ExpandProperty Count`;

  return Number(powershell(script));
}

function removeDenyAces(path) {
  const script = [
    `$acl = Get-Acl -LiteralPath '${quoted(path)}'`,
    `$deny = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' })`,
    'if ($deny.Count -gt 0) {',
    '  $deny | ForEach-Object { [void]$acl.RemoveAccessRule($_) }',
    `  Set-Acl -LiteralPath '${quoted(path)}' -AclObject $acl`,
    '}',
    '$deny.Count',
  ].join('; ');

  return Number(powershell(script));
}

if (process.platform !== 'win32') {
  console.log('unblock: not on Windows, nothing to do');
  process.exit(0);
}

const before = { label: labelOf(root), denies: denyCount(root) };
const dirty = before.label === 'low' || before.denies > 0;

console.log(`unblock: ${root}`);
console.log(`  before: label=${before.label} deny=${before.denies}`);

if (!dirty) {
  console.log('unblock: directory is already writable');
  process.exit(0);
}

if (checkOnly) {
  console.log('unblock: would clear the low label and the deny rules');
  process.exit(1);
}

if (before.denies > 0) {
  console.log(`  removed ${removeDenyAces(root)} deny rule(s)`);
}

// Medium is the level a normal user directory has; (OI)(CI) pushes it down so
// files created later inherit it instead of falling back to the stale label.
run('icacls', [root, '/setintegritylevel', '(OI)(CI)Medium']);

const after = { label: labelOf(root), denies: denyCount(root) };

console.log(`  after:  label=${after.label} deny=${after.denies}`);

if (after.label === 'low' || after.denies > 0) {
  console.error('unblock: the directory is still restricted');
  process.exit(1);
}

console.log('unblock: directory is writable again');
