import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSING, DISCLAIMER, findDashes, run } from '../../../scripts/copy-check.mjs';
import { EM_DASH, EN_DASH, scratchRepo, writeFiles } from './helpers.js';

const README = `# scratch\n\n${DISCLAIMER}\n\n${CLOSING}\n`;
const MESSAGES = `export const CLOSING_SENTENCE =\n  '${CLOSING}';\n`;
const GOOD = { 'README.md': README, 'src/report/messages.ts': MESSAGES };

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = scratchRepo(files);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const check = (dir: string) => run(['--repo', dir]);

describe('copy-check', () => {
  it('finds dashes with line and column', () => {
    expect(findDashes(`ab\nc${EM_DASH}d${EN_DASH}`)).toEqual([
      { line: 2, col: 2, char: EM_DASH },
      { line: 2, col: 4, char: EN_DASH },
    ]);
    expect(findDashes('a - b -- c')).toEqual([]);
  });

  it('passes a repo with the sentences and no dashes', () => {
    const r = check(repo(GOOD));
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe('PASS');
  });

  it('accepts the sentences wrapped across lines', () => {
    const wrapped = README.replace('Amplitude or', 'Amplitude\nor').replace(
      'broken, not',
      'broken,\nnot',
    );
    expect(check(repo({ ...GOOD, 'README.md': wrapped })).code).toBe(0);
  });

  it('fails on an em dash in the README (negative control)', () => {
    const r = check(repo({ ...GOOD, 'README.md': `${README}one ${EM_DASH} two\n` }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('README.md:6:5: em dash (G7)');
  });

  it('fails on an en dash in any tracked text file', () => {
    const r = check(repo({ ...GOOD, 'docs/x.md': `1${EN_DASH}2\n` }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('docs/x.md:1:2: en dash (G7)');
  });

  it('fails on a dash in an untracked, not ignored file', () => {
    const dir = repo(GOOD);
    writeFiles(dir, { 'new.md': `a${EM_DASH}b\n` });
    expect(check(dir).code).toBe(1);
  });

  it('fails on a README without the disclaimer (negative control)', () => {
    const r = check(repo({ ...GOOD, 'README.md': `# scratch\n\n${CLOSING}\n` }));
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/README\.md lacks the disclaimer/);
  });

  it('fails on a README without the closing sentence', () => {
    const r = check(repo({ ...GOOD, 'README.md': `# scratch\n\n${DISCLAIMER}\n` }));
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/README\.md lacks the closing sentence/);
  });

  it('fails on a missing README', () => {
    const r = check(repo({ 'src/report/messages.ts': MESSAGES }));
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/README\.md is missing/);
  });

  it('fails when messages lack the closing sentence or are missing (with a src tree)', () => {
    const without = check(repo({ ...GOOD, 'src/report/messages.ts': 'export {};\n' }));
    expect(without.code).toBe(1);
    expect(without.out.join('\n')).toMatch(/messages\.ts lacks the closing sentence/);
    const missing = check(repo({ 'README.md': README, 'src/other.ts': 'export {};\n' }));
    expect(missing.code).toBe(1);
    expect(missing.out.join('\n')).toMatch(/messages\.ts is missing/);
  });

  it('skips the messages.ts check for a repo with no src tree (the Action and demo copies)', () => {
    const r = check(repo({ 'README.md': README }));
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).not.toMatch(/messages\.ts/);
  });

  it('fails on a dash written as an escape in the message strings', () => {
    const escaped = `${MESSAGES}export const X = 'a \\u2014 b';\nexport const Y = 'c \\u{2013} d';\n`;
    const r = check(repo({ ...GOOD, 'src/report/messages.ts': escaped }));
    expect(r.code).toBe(1);
    expect(r.out.filter((l: string) => l.includes('dash escape'))).toHaveLength(2);
  });

  it('ignores binary files', () => {
    expect(check(repo({ ...GOOD, 'img.bin': `\0${EM_DASH}` })).code).toBe(0);
  });

  it('exits 2 on an unknown argument', () => {
    expect(run(['--nope']).code).toBe(2);
  });
});
