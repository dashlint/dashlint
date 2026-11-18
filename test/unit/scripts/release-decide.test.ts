import { describe, expect, it } from 'vitest';
import { decide } from '../../../scripts/release-decide.mjs';

const pkg = (version: string, name = 'shelfwise') => JSON.stringify({ name, version });
const ok = (versions: string[]) => () => ({
  status: 0,
  stdout: JSON.stringify(versions),
  stderr: '',
});

describe('release-decide', () => {
  it('stages a version that is not on npm yet', () => {
    const d = decide(pkg('0.1.1'), ok(['0.1.0']));
    expect(d).toMatchObject({ code: 0, stage: true, version: '0.1.1' });
  });

  it('never stages a version already on npm', () => {
    const d = decide(pkg('0.1.0'), ok(['0.1.0']));
    expect(d).toMatchObject({ code: 0, stage: false, version: '0.1.0' });
    expect(d.reason).toContain('already on npm');
  });

  it('reads a single version printed as a plain string', () => {
    const d = decide(pkg('0.1.0'), () => ({ status: 0, stdout: '"0.1.0"', stderr: '' }));
    expect(d).toMatchObject({ code: 0, stage: false });
  });

  it('skips while the package does not exist (the first version is published by hand)', () => {
    const d = decide(pkg('0.1.0'), () => ({
      status: 1,
      stdout: '',
      stderr: 'npm error code E404\nnpm error 404 Not Found',
    }));
    expect(d).toMatchObject({ code: 0, stage: false });
    expect(d.reason).toContain('published by hand');
  });

  it('fails on any other registry error instead of guessing', () => {
    const d = decide(pkg('0.1.1'), () => ({
      status: 1,
      stdout: '',
      stderr: 'npm error ETIMEDOUT',
    }));
    expect(d.code).toBe(1);
    expect(d.stage).toBeUndefined();
  });

  it('fails on unusable package.json', () => {
    expect(decide('{', ok([])).code).toBe(1);
    expect(decide(JSON.stringify({ version: '0.1.0' }), ok([])).code).toBe(1);
    expect(decide(pkg('next'), ok([])).code).toBe(1);
    expect(decide(pkg('0.1.1'), () => ({ status: 0, stdout: 'oops', stderr: '' })).code).toBe(1);
  });
});
