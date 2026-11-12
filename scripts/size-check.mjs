#!/usr/bin/env node
// Size check (spec T1.5, §6.11): the Action bundle (dist/action.mjs) and the npm pack tarball must
// stay within budget. Budgets are preliminary (set in T1.5, before the real checker and descriptors
// exist); raising either is a class 2 ADR in the notes repo (§4.5), recorded in notes/metrics/size.md.
//
// Usage: node scripts/size-check.mjs
// Exit: 0 both within budget, 1 over budget, 2 the bundle is missing (run `npm run build` first).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const BUNDLE = join(ROOT, 'dist', 'action.mjs');

// The Action bundle inlines `typescript` once the checker is wired in (expect about 10 MB, §6.11);
// this budget leaves headroom above that for the skeleton period.
export const BUNDLE_BUDGET_BYTES = 12 * 1024 * 1024;
// The npm package is unbundled; its tracked footprint today is a few KB and grows with descriptors,
// builtins and docs through v0.1.
export const PACK_BUDGET_BYTES = 5 * 1024 * 1024;

export function bundleSize(bundle = BUNDLE) {
  if (!existsSync(bundle)) return null;
  return statSync(bundle).size;
}

export function packSize(root = ROOT, run = spawnSync) {
  const dest = mkdtempSync(join(tmpdir(), 'dashlint-pack-'));
  try {
    const r = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dest], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0)
      throw new Error(`npm pack failed: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
    const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error('npm pack wrote no tarball');
    return statSync(join(dest, tgz)).size;
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

export function evaluate({ bundle = bundleSize(), pack = packSize() } = {}) {
  const out = [];
  let code = 0;
  if (bundle === null) {
    out.push(`${BUNDLE} is missing (run npm run build first)`);
    return { code: 2, out };
  }
  out.push(`action bundle: ${bundle} bytes (budget ${BUNDLE_BUDGET_BYTES})`);
  if (bundle > BUNDLE_BUDGET_BYTES) {
    out.push('FAIL: action bundle over budget');
    code = 1;
  }
  out.push(`npm pack: ${pack} bytes (budget ${PACK_BUDGET_BYTES})`);
  if (pack > PACK_BUDGET_BYTES) {
    out.push('FAIL: npm pack over budget');
    code = 1;
  }
  if (code === 0) out.push('PASS');
  return { code, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { code, out } = evaluate();
  process.stdout.write(`${out.join('\n')}\n`);
  process.exitCode = code;
}
