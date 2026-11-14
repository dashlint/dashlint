import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSING, DISCLAIMER } from '../../../scripts/copy-check.mjs';
import { findMapFiles, parseArgs, run } from '../../../scripts/sync-action.mjs';
import { scratchRepo, writeFiles } from './helpers.js';

const README = `# dashlint action\n\n${DISCLAIMER}\n\n${CLOSING}\n`;

const dirs: string[] = [];
function sourceTree(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'dashlint-sync-src-'));
  dirs.push(dir);
  writeFiles(dir, {
    'action.yml': 'name: dashlint\n',
    'README.md': README,
    'smoke.yml': 'name: smoke\n',
    'dist/action.mjs': 'export {};\n',
    'descriptors/shelf.yml': 'sdk: shelf\n',
    'descriptors/stubs/shelf.d.ts': 'export {};\n',
    LICENSE: 'MIT\n',
  });
  return {
    actionYml: join(dir, 'action.yml'),
    readme: join(dir, 'README.md'),
    smoke: join(dir, 'smoke.yml'),
    bundle: join(dir, 'dist/action.mjs'),
    descriptors: join(dir, 'descriptors'),
    license: join(dir, 'LICENSE'),
  };
}
function filesFrom(t: ReturnType<typeof sourceTree>) {
  return [
    { from: t.actionYml, to: 'action.yml' },
    { from: t.readme, to: 'README.md' },
    { from: t.smoke, to: '.github/workflows/smoke.yml' },
    { from: t.bundle, to: 'dist/action.mjs' },
    { from: t.descriptors, to: 'descriptors' },
    { from: t.license, to: 'LICENSE' },
  ];
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('sync-action parseArgs', () => {
  it('requires --version', () => {
    expect(() => parseArgs([], {})).toThrow(/--version is required/);
  });

  it('rejects a non-semver version', () => {
    expect(() => parseArgs(['--version', 'latest'], {})).toThrow(/not a semver/);
  });

  it('accepts a semver and defaults dry-run to false', () => {
    const opts = parseArgs(['--version', '0.1.0'], {});
    expect(opts.version).toBe('0.1.0');
    expect(opts.dryRun).toBe(false);
  });
});

describe('sync-action run', () => {
  it('dry run stages the files and reads CLEAN', () => {
    const files = filesFrom(sourceTree());
    const r = run(['--version', '0.0.0', '--dry-run'], {}, { files });
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/staged 6 file\(s\)/);
    expect(r.out.at(-1)).toBe('CLEAN');
  });

  it('fails on a stray .map file in the copy (negative control)', () => {
    const t = sourceTree();
    writeFileSync(join(t.bundle, '..', 'action.mjs.map'), '{}');
    const files = [
      ...filesFrom(t),
      { from: join(t.bundle, '..', 'action.mjs.map'), to: 'dist/action.mjs.map' },
    ];
    const r = run(['--version', '0.0.0', '--dry-run'], {}, { files });
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/FAIL: \.map file\(s\) in the copy: dist\/action\.mjs\.map/);
  });

  it('finds .map files anywhere under a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashlint-maps-'));
    dirs.push(dir);
    writeFiles(dir, { 'a/b/c.mjs.map': '{}', 'a/ok.mjs': 'export {};\n' });
    expect(findMapFiles(dir)).toHaveLength(1);
  });

  it('fails the denylist scan when a strict term is in the copy (negative control)', () => {
    const t = sourceTree();
    writeFileSync(t.readme, `${README}zebrafinch\n`);
    const listDir = mkdtempSync(join(tmpdir(), 'dashlint-list-'));
    dirs.push(listDir);
    writeFileSync(join(listDir, 'denylist.txt'), 'zebrafinch\n');
    const files = filesFrom(t);
    const r = run(
      ['--version', '0.0.0', '--dry-run', '--denylist', join(listDir, 'denylist.txt')],
      {},
      { files },
    );
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/FAIL: denylist scan/);
  });

  it('exits 2 when a source file is missing', () => {
    const t = sourceTree();
    rmSync(t.license);
    const r = run(['--version', '0.0.0', '--dry-run'], {}, { files: filesFrom(t) });
    expect(r.code).toBe(2);
    expect(r.out.join('\n')).toMatch(/missing source file/);
  });

  it('exits 2 on usage errors', () => {
    expect(run([], {}).code).toBe(2);
  });

  it('without --dry-run, commits the branch into --dest', () => {
    const files = filesFrom(sourceTree());
    const dest = scratchRepo({ 'README.md': '# placeholder\n' });
    dirs.push(dest);
    const r = run(['--version', '0.2.0', '--dest', dest], {}, { files });
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/committed action\/v0\.2\.0 in/);
    const branch = execFileSync('git', ['-C', dest, 'branch', '--show-current'], {
      encoding: 'utf8',
    }).trim();
    expect(branch).toBe('action/v0.2.0');
    const log = execFileSync('git', ['-C', dest, 'log', '-1', '--format=%s'], {
      encoding: 'utf8',
    }).trim();
    expect(log).toBe('chore: sync action v0.2.0');
    // The bundle reads descriptors/ beside dist/: the folder arrives whole.
    const tracked = execFileSync('git', ['-C', dest, 'ls-files', 'descriptors'], {
      encoding: 'utf8',
    });
    expect(tracked.trim().split('\n')).toEqual([
      'descriptors/shelf.yml',
      'descriptors/stubs/shelf.d.ts',
    ]);
    // `.github` shares the `.git` prefix; the staging repo's own .git must be the only thing left out.
    const all = execFileSync('git', ['-C', dest, 'ls-files'], { encoding: 'utf8' });
    expect(all.trim().split('\n').sort()).toEqual([
      '.github/workflows/smoke.yml',
      'LICENSE',
      'README.md',
      'action.yml',
      'descriptors/shelf.yml',
      'descriptors/stubs/shelf.d.ts',
      'dist/action.mjs',
    ]);
  });

  it('exits 2 when --dest does not exist', () => {
    const files = filesFrom(sourceTree());
    const r = run(
      ['--version', '0.3.0', '--dest', join(tmpdir(), 'dashlint-missing-dest-xyz')],
      {},
      { files },
    );
    expect(r.code).toBe(2);
    expect(r.out.join('\n')).toMatch(/does not exist/);
  });
});
