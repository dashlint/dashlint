import { describe, expect, it } from 'vitest';
import { BUNDLE_BUDGET_BYTES, PACK_BUDGET_BYTES, evaluate } from '../../../scripts/size-check.mjs';

describe('size-check', () => {
  it('passes when both sizes are within budget', () => {
    const r = evaluate({ bundle: 1024, pack: 1024 });
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe('PASS');
  });

  it('fails when the bundle is over budget (negative control)', () => {
    const r = evaluate({ bundle: BUNDLE_BUDGET_BYTES + 1, pack: 1024 });
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/FAIL: action bundle over budget/);
  });

  it('fails when the pack tarball is over budget (negative control)', () => {
    const r = evaluate({ bundle: 1024, pack: PACK_BUDGET_BYTES + 1 });
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/FAIL: npm pack over budget/);
  });

  it('reports both failures when both are over budget', () => {
    const r = evaluate({ bundle: BUNDLE_BUDGET_BYTES + 1, pack: PACK_BUDGET_BYTES + 1 });
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/action bundle over budget/);
    expect(r.out.join('\n')).toMatch(/npm pack over budget/);
  });

  it('exits 2 when the bundle is missing', () => {
    const r = evaluate({ bundle: null, pack: 1024 });
    expect(r.code).toBe(2);
    expect(r.out.join('\n')).toMatch(/is missing \(run npm run build first\)/);
  });

  it('accepts a bundle exactly at the budget', () => {
    expect(evaluate({ bundle: BUNDLE_BUDGET_BYTES, pack: PACK_BUDGET_BYTES }).code).toBe(0);
  });
});
