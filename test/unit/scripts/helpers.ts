import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// A scratch git repository with the given files committed under the given message.
export function scratchRepo(files: Record<string, string>, message = 'chore: scratch'): string {
  const dir = mkdtempSync(join(tmpdir(), 'dashlint-test-'));
  writeFiles(dir, files);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'user.name=Scratch',
        '-c',
        'user.email=scratch@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { stdio: 'pipe' },
    );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', message);
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

export const EM_DASH = String.fromCodePoint(0x2014);
export const EN_DASH = String.fromCodePoint(0x2013);
