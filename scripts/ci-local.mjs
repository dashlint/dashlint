#!/usr/bin/env node
// ci:local (spec T1.4, G17): the full gate a commit must pass before it is pushed. Steps run in
// order and all run even after a failure, so one `npm run ci:local` shows every problem at once.
// Schema checks are a no-op until P2 (no schema to check yet); the size check is a no-op until
// T1.5 (no bundle to measure yet).
//
// Usage: node scripts/ci-local.mjs
// Exit: 0 all steps passed, 1 at least one step failed.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');

function runNpm(args, label) {
  const r = spawnSync('npm', ['run', ...args], { cwd: ROOT, stdio: 'inherit' });
  return { label, code: r.status ?? 1 };
}

function runNode(script, args, label) {
  const r = spawnSync('node', [resolve(ROOT, script), ...args], { cwd: ROOT, stdio: 'inherit' });
  return { label, code: r.status ?? 1 };
}

function noop(label, reason) {
  process.stdout.write(`${label}: SKIPPED (${reason})\n`);
  return { label, code: 0 };
}

export function run() {
  const steps = [
    runNpm(['build'], 'build'),
    runNpm(['test'], 'test'),
    runNpm(['test:coverage'], 'test:coverage'),
    runNpm(['lint'], 'lint'),
    noop('schema checks', 'no schema to check until P2'),
    runNode('scripts/denylist-scan.mjs', [], 'denylist scan'),
    runNode('scripts/copy-check.mjs', [], 'copy check'),
    noop('size check', 'no bundle to measure until T1.5'),
  ];
  process.stdout.write('\nci:local summary:\n');
  for (const s of steps) process.stdout.write(`  ${s.code === 0 ? 'PASS' : 'FAIL'}  ${s.label}\n`);
  const failed = steps.filter((s) => s.code !== 0);
  process.stdout.write(failed.length ? `FAIL: ${failed.length} step(s)\n` : 'PASS\n');
  return failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run();
}
