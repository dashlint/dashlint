import { describe, expect, it } from 'vitest';
import type { Report } from '../../../src/formats/report.js';
import { formatValidationErrors, validateReport } from '../../../src/formats/validate.js';
import { fixture, fixtureFiles, invalidCases } from './fixtures.js';

const base = () => structuredClone(fixture('report', 'valid', 'base.json')) as Report;

function errorPaths(data: unknown): string[] {
  const r = validateReport(data);
  return r.ok ? [] : r.errors.map((e) => e.path);
}

describe('dashlint.report/1 fixtures', () => {
  const cases = invalidCases('report');

  it('has an expectation for every invalid fixture and a fixture for every expectation', () => {
    expect(fixtureFiles('report', 'invalid')).toEqual(Object.keys(cases).sort());
  });

  it.each(fixtureFiles('report', 'valid'))('accepts valid/%s', (file) => {
    const r = validateReport(fixture('report', 'valid', file));
    expect(r.ok ? [] : formatValidationErrors(r.errors)).toEqual([]);
  });

  it.each(Object.entries(cases))('rejects invalid/%s and names the field', (file, c) => {
    expect(errorPaths(fixture('report', 'invalid', file))).toContain(c.path);
  });
});

describe('dashlint.report/1 rules', () => {
  it('keeps code facts three-valued', () => {
    for (const code of ['yes', 'no', 'unknown']) {
      const r = base();
      (r.tiles[0]?.findings[0] as { code: string }).code = code;
      expect(validateReport(r).ok).toBe(true);
    }
    const r = base();
    (r.tiles[0]?.findings[0] as { code: string }).code = 'true';
    expect(errorPaths(r)).toEqual(['/tiles/0/findings/0/code']);
  });

  it('accepts lastSeenAt null or a UTC timestamp, not a local time', () => {
    const r = base();
    const entry = r.notArriving[0];
    if (!entry) throw new Error('fixture changed');
    entry.lastSeenAt = '2026-12-17T22:41:00Z';
    expect(validateReport(r).ok).toBe(true);
    entry.lastSeenAt = '2026-12-17T22:41:00+05:30';
    expect(errorPaths(r)).toContain('/notArriving/0/lastSeenAt');
  });

  it('keeps true and "true" apart in finding values', () => {
    const r = base();
    const finding = r.tiles[0]?.findings[0];
    if (!finding) throw new Error('fixture changed');
    finding.values = [true, 'true'];
    expect(validateReport(r).ok).toBe(true);
  });
});
