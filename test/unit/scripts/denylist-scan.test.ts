import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeMatchers, npmCommand, run, scanText } from '../../../scripts/denylist-scan.mjs';
import { scratchRepo, writeFiles } from './helpers.js';

// Invented terms only: the real denylist never enters this repository.
const STRICT = ['# a comment line', 'zebrafinch', 'Quokka-Labs'];
const REVIEW = ['otter'];

const dirs: string[] = [];
function lists(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dashlint-lists-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'denylist.txt'), `${STRICT.join('\n')}\n\n`);
  writeFileSync(join(dir, 'denylist-review.txt'), `${REVIEW.join('\n')}\n`);
  return join(dir, 'denylist.txt');
}
function repo(files: Record<string, string>, message?: string): string {
  const dir = scratchRepo(files, message);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const scan = (args: string[], env: Record<string, string> = {}) => run(args, env);

describe('denylist-scan matching', () => {
  it('matches strict terms as case-insensitive substrings', () => {
    const m = makeMatchers(['zebrafinch'], []);
    expect(scanText('a ZebraFinches b', m, (n: number) => `l${n}`)).toEqual([
      { tier: 'strict', where: 'l1', term: 'ZebraFinch' },
    ]);
  });

  it('matches review terms only as whole words', () => {
    const m = makeMatchers([], ['otter']);
    expect(scanText('an Otter here', m, () => 'x')).toHaveLength(1);
    expect(scanText('otters and blotter', m, () => 'x')).toHaveLength(0);
  });

  it('escapes regular expression characters in terms', () => {
    const m = makeMatchers(['a.b'], []);
    expect(scanText('axb', m, () => 'x')).toHaveLength(0);
    expect(scanText('a.b', m, () => 'x')).toHaveLength(1);
  });
});

describe('denylist-scan', () => {
  it('skips and says so when no denylist is given (CI)', () => {
    const r = scan(['--repo', '.']);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toMatch(/^SKIPPED: no denylist/);
  });

  it('reads the denylist path from DASHLINT_DENYLIST', () => {
    const dir = repo({ 'a.txt': 'nothing here\n' });
    const r = scan(['--repo', dir, '--skip', 'pack'], { DASHLINT_DENYLIST: lists() });
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe('CLEAN');
  });

  it('exits 2 when the given denylist does not exist', () => {
    const r = scan(['--denylist', '/nonexistent/denylist.txt', '--skip', 'pack']);
    expect(r.code).toBe(2);
  });

  it('exits 2 on an unknown argument or source', () => {
    expect(scan(['--bogus']).code).toBe(2);
    expect(scan(['--skip', 'nowhere']).code).toBe(2);
  });

  it('reads CLEAN on a clean repo and ignores comment lines', () => {
    const dir = repo({ 'README.md': 'a comment line is not a term\n' });
    const r = scan(['--denylist', lists(), '--repo', dir, '--skip', 'pack']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('terms: 2 strict, 1 review');
    expect(r.out.at(-1)).toBe('CLEAN');
  });

  it('blocks a strict term in the working tree with file and line', () => {
    const dir = repo({ 'docs/a.md': 'line one\nmade by quokka-labs\n' });
    const r = scan(['--denylist', lists(), '--repo', dir, '--skip', 'history,pack']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('STRICT tree docs/a.md:2: quokka-labs');
  });

  it('scans untracked files that are not ignored, and skips ignored ones', () => {
    const dir = repo({ '.gitignore': 'ignored.txt\n' });
    writeFiles(dir, { 'new.txt': 'zebrafinch\n', 'ignored.txt': 'zebrafinch\n' });
    const r = scan(['--denylist', lists(), '--repo', dir, '--skip', 'history,pack']);
    expect(r.code).toBe(1);
    expect(r.out.filter((l: string) => l.startsWith('STRICT'))).toEqual([
      'STRICT tree new.txt:1: zebrafinch',
    ]);
  });

  it('blocks a strict term planted in a commit message (negative control)', () => {
    const dir = repo({ 'a.txt': 'clean\n' }, 'feat: add the Zebrafinch importer');
    const r = scan(['--denylist', lists(), '--repo', dir, '--skip', 'pack']);
    expect(r.code).toBe(1);
    expect(r.out.some((l: string) => /^STRICT history commit [0-9a-f]{7} /.test(l))).toBe(true);
  });

  it('finds a term that was removed from the tree but stays in history', () => {
    const dir = repo({ 'a.txt': 'zebrafinch\n' });
    writeFiles(dir, { 'a.txt': 'clean now\n' });
    const tree = scan(['--denylist', lists(), '--repo', dir, '--skip', 'history,pack']);
    const hist = scan(['--denylist', lists(), '--repo', dir, '--skip', 'tree,pack']);
    expect(tree.code).toBe(0);
    expect(hist.code).toBe(1);
  });

  it('lists review terms without blocking', () => {
    const dir = repo({ 'a.txt': 'an otter swims\n' });
    const r = scan(['--denylist', lists(), '--repo', dir, '--skip', 'pack']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('REVIEW tree a.txt:1: otter');
    expect(r.out.at(-1)).toMatch(/^CLEAN \(\d+ review-tier hits/);
  });

  it('scans the Action bundle when it is built', () => {
    const dir = repo({ '.gitignore': 'dist/\n' });
    writeFiles(dir, { 'dist/action.mjs': 'const x = "zebrafinch";\n' });
    const r = scan(['--denylist', lists(), '--repo', dir, '--skip', 'history,pack']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('STRICT bundle dist/action.mjs:1: zebrafinch');
  });

  it('scans any directory given with --dir', () => {
    const dir = repo({});
    const extra = mkdtempSync(join(tmpdir(), 'dashlint-dir-'));
    dirs.push(extra);
    writeFiles(extra, { 'deep/x.json': '{"n": "Zebrafinch"}\n' });
    const r = scan([
      '--denylist',
      lists(),
      '--repo',
      dir,
      '--skip',
      'history,pack',
      '--dir',
      extra,
    ]);
    expect(r.code).toBe(1);
    expect(r.out.some((l: string) => /^STRICT dir .*deep\/x\.json:1: Zebrafinch$/.test(l))).toBe(
      true,
    );
  });

  it('starts npm through node on Windows, where npm is a .cmd file', () => {
    expect(npmCommand('linux', '/usr/bin/node')).toEqual(['npm', []]);
    const [cmd, pre] = npmCommand('win32', '/node/node.exe');
    expect(cmd).toBe('/node/node.exe');
    expect(pre.map((p: string) => p.replace(/\\/g, '/'))).toEqual([
      '/node/node_modules/npm/bin/npm-cli.js',
    ]);
  });

  it('scans the npm pack tarball contents, not files outside "files"', { timeout: 60000 }, () => {
    const dir = repo({
      'package.json': JSON.stringify({ name: 'scratch-pkg', version: '0.0.0', files: ['lib'] }),
      'lib/index.js': 'export const a = "zebrafinch";\n',
    });
    const r = scan(['--denylist', lists(), '--repo', dir, '--skip', 'tree,history']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('STRICT pack package/lib/index.js:1: zebrafinch');
  });
});
