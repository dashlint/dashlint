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
});
