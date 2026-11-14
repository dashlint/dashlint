#!/usr/bin/env node
// Build (spec T1.5, §6.11): `tsc` to dist/ (the published CLI, unbundled), then esbuild bundles the
// Action entry point into a single dist/action.mjs for dashlint/action (no .map file).
//
// Usage: node scripts/build.mjs
// Exit: 0 both steps passed, 1 a step failed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
const TSC = resolve(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const BANNER = [
  "import { createRequire as __dlRequire } from 'node:module';",
  "import { fileURLToPath as __dlPath } from 'node:url';",
  "import { dirname as __dlDirname } from 'node:path';",
  'const require = __dlRequire(import.meta.url);',
  'const __filename = __dlPath(import.meta.url);',
  'const __dirname = __dlDirname(__filename);',
].join('\n');

function tsc() {
  const r = spawnSync('node', [TSC, '-p', 'tsconfig.json'], { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

async function bundleAction() {
  try {
    const { version } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    await esbuild.build({
      // The bundle has no package.json beside it to read its version from (src/action/main.ts).
      // dist/action.mjs reads descriptors/ beside dist/, in this repo and in dashlint/action alike.
      define: {
        __DASHLINT_VERSION__: JSON.stringify(version),
        __DASHLINT_DESCRIPTORS__: JSON.stringify('../descriptors/'),
      },
      // The bundled `typescript` is CommonJS: it calls require('fs') and reads __filename.
      banner: { js: BANNER },
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
