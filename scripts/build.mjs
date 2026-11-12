#!/usr/bin/env node
// Build (spec T1.5, §6.11): `tsc` to dist/ (the published CLI, unbundled), then esbuild bundles the
// Action entry point into a single dist/action.mjs for dashlint/action (no .map file).
//
// Usage: node scripts/build.mjs
// Exit: 0 both steps passed, 1 a step failed.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const TSC = resolve(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function tsc() {
  const r = spawnSync('node', [TSC, '-p', 'tsconfig.json'], { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

async function bundleAction() {
  try {
    await esbuild.build({
      entryPoints: [resolve(ROOT, 'src/action/main.ts')],
      outfile: resolve(ROOT, 'dist/action.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      sourcemap: false,
    });
    return 0;
  } catch (e) {
    process.stderr.write(`esbuild: ${e.message}\n`);
    return 1;
  }
}

export async function run() {
  const tscCode = tsc();
  if (tscCode !== 0) {
    process.stdout.write('build: tsc failed, skipping the Action bundle\n');
    return 1;
  }
  const bundleCode = await bundleAction();
  return bundleCode === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run();
}
