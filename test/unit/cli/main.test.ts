import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { helpText, readVersion, run } from '../../../src/cli/main.js';

async function runIt(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd: process.cwd(),
    env: {},
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('cli main', () => {
  it('prints the package version for --version', async () => {
    const r = await runIt(['--version']);
    expect(r).toEqual({ code: 0, out: readVersion(), err: '' });
  });

  it('prints help for --help, also after a command', async () => {
    expect((await runIt(['--help'])).out).toBe(helpText());
    expect((await runIt(['check', '--help'])).out).toBe(helpText());
    expect(helpText()).toMatch(/^ {2}extract /m);
    expect(helpText()).toMatch(/^ {2}--no-color /m);
  });

  it('with no command it is exit 2 naming the commands', async () => {
    const r = await runIt([]);
    expect(r.code).toBe(2);
    expect(r.err).toBe(
      'dashlint: name a command: init, extract, pull, check, audit or diff (dashlint --help lists them)',
    );
  });

  it('prints the version when run through a symlink, as a package manager bin does', () => {
    const distMain = fileURLToPath(new URL('../../../dist/cli/main.js', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'dashlint-bin-'));
    const link = join(dir, 'dashlint');
    try {
      symlinkSync(distMain, link);
      const result = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(readVersion());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
