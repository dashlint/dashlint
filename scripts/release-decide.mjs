#!/usr/bin/env node
// Release decision (spec T13.2, §6.11): tells .github/workflows/release.yml whether to stage the
// version in package.json. The first version is published by hand at the release sitting, so
// nothing is staged while the package does not exist on npm; a version already on npm is never
// staged again. Any other registry answer fails the job instead of guessing.
//
// Usage: node scripts/release-decide.mjs
// Prints GitHub step outputs: `stage=true|false`, `version=<x.y.z>`, `reason=<text>`.
// Exit: 0 decided, 1 the registry could not be read or package.json is unusable.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

function npmVersions(name) {
  const r = spawnSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Decides from package.json text and an `npm view <name> versions --json` result. */
export function decide(pkgText, view) {
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    return { code: 1, error: 'package.json is not valid JSON' };
  }
  const { name, version } = pkg ?? {};
  if (typeof name !== 'string' || !name) return { code: 1, error: 'package.json has no name' };
  if (typeof version !== 'string' || !SEMVER.test(version))
    return { code: 1, error: `package.json version "${version}" is not a semver` };
  const r = view(name);
  if (r.status !== 0) {
    if (/\bE404\b/.test(`${r.stderr}\n${r.stdout}`))
      return {
        code: 0,
        stage: false,
        version,
        reason: `${name} is not on npm yet; the first version is published by hand`,
      };
    return { code: 1, error: `npm view ${name} failed: ${r.stderr.trim().slice(0, 300)}` };
  }
  let versions;
  try {
    const parsed = JSON.parse(r.stdout);
    versions = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return { code: 1, error: `npm view ${name} printed no JSON` };
  }
  if (versions.includes(version))
    return { code: 0, stage: false, version, reason: `${name}@${version} is already on npm` };
  return { code: 0, stage: true, version, reason: `${name}@${version} is not on npm yet` };
}

export function run({ root = ROOT, view = npmVersions } = {}) {
  const d = decide(readFileSync(resolve(root, 'package.json'), 'utf8'), view);
  if (d.code !== 0) return { code: d.code, out: [`release-decide: ${d.error}`] };
  return {
    code: 0,
    out: [`stage=${d.stage}`, `version=${d.version}`, `reason=${d.reason}`],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { code, out } = run();
  (code === 0 ? process.stdout : process.stderr).write(`${out.join('\n')}\n`);
  process.exitCode = code;
}
