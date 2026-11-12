import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { helpText, readVersion, run } from '../../../src/cli/main.js';

describe('cli main', () => {
  it('prints the package version for --version', () => {
    expect(run(['--version'])).toBe(readVersion());
  });

  it('prints help text by default', () => {
    expect(run([])).toBe(helpText);
    expect(run(['--help'])).toBe(helpText);
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
