import { describe, expect, it } from 'vitest';
import type { Requirements, SeriesNode } from '../../../src/formats/requirements.js';
import { formatValidationErrors, validateRequirements } from '../../../src/formats/validate.js';
import { fixture, fixtureFiles, invalidCases } from './fixtures.js';

const base = () => structuredClone(fixture('requirements', 'valid', 'base.json')) as Requirements;

function errorPaths(data: unknown): string[] {
  const r = validateRequirements(data);
  return r.ok ? [] : r.errors.map((e) => e.path);
}

function firstTile(r: Requirements) {
  const tile = r.tiles[0];
  if (!tile) throw new Error('fixture changed');
  return tile;
}

describe('dashlint.requirements/1 fixtures', () => {
  const cases = invalidCases('requirements');

  it('has an expectation for every invalid fixture and a fixture for every expectation', () => {
    expect(fixtureFiles('requirements', 'invalid')).toEqual(Object.keys(cases).sort());
  });

  it.each(fixtureFiles('requirements', 'valid'))('accepts valid/%s', (file) => {
    const r = validateRequirements(fixture('requirements', 'valid', file));
    expect(r.ok ? [] : formatValidationErrors(r.errors)).toEqual([]);
  });

  it.each(Object.entries(cases))('rejects invalid/%s and names the field', (file, c) => {
    expect(errorPaths(fixture('requirements', 'invalid', file))).toContain(c.path);
  });
});

describe('dashlint.requirements/1 rules', () => {
  it('accepts every series node kind and rejects any other (negative control)', () => {
    const nodes: SeriesNode[] = [
      { ref: 'A', node: 'event', event: 'book_viewed' },
      { ref: 'A', node: 'group', operator: 'OR', events: [{ event: 'book_viewed' }] },
      { ref: 'A', node: 'all-events' },
      { ref: 'A', node: 'action', action: { id: 1, steps: [{ event: 'order_completed' }] } },
      { ref: 'A', node: 'warehouse' },
    ];
    for (const node of nodes) {
      const r = base();
      firstTile(r).series = [node];
      expect(validateRequirements(r).ok).toBe(true);
    }
    const r = base();
    firstTile(r).series = [{ ref: 'A', node: 'session', event: 'book_viewed' } as never];
    expect(errorPaths(r)).toEqual(['/tiles/0/series/0/node']);
  });

  it('stores which alert bounds exist, never a threshold value (negative control)', () => {
    const alert = () => {
      const r = base();
      const a = r.alerts?.[0];
      if (!a) throw new Error('fixture changed');
      return {
        r,
        a: a as unknown as Record<string, unknown> & { bounds: Record<string, unknown> },
      };
    };
    for (const [lower, upper] of [
      [true, false],
      [false, true],
      [true, true],
      [false, false],
    ]) {
      const { r, a } = alert();
      a.bounds = { lower, upper };
      expect(validateRequirements(r).ok).toBe(true);
    }
    for (const field of ['threshold', 'last_value', 'lastValue', 'value']) {
      const { r, a } = alert();
      a[field] = 0.25;
      expect(errorPaths(r)).toEqual([`/alerts/0/${field}`]);
    }
    const { r, a } = alert();
    a.bounds['lower'] = 0;
    expect(errorPaths(r)).toEqual(['/alerts/0/bounds/lower']);
  });

  it('keeps an out-of-range alert index valid: that is a check finding, not a format error', () => {
    const r = base();
    const a = r.alerts?.[0];
    if (!a) throw new Error('fixture changed');
    a.target = { kind: 'formula', index: 3 };
    expect(validateRequirements(r).ok).toBe(true);
  });

  it('keeps a funnel step identified by its index: the same event may repeat', () => {
    const r = base();
    const t = firstTile(r);
    t.kind = 'funnels';
    t.series = ['A', 'B', 'C'].map((ref) => ({ ref, node: 'event', event: 'checkout_step' }));
    expect(validateRequirements(r).ok).toBe(true);
  });

  it('keeps true and "true" apart in filter values', () => {
    const r = base();
    const f = firstTile(r).series?.[0];
    if (f?.node !== 'event' || !f.filters?.[0] || 'any' in f.filters[0])
      throw new Error('fixture changed');
    f.filters[0].values = [true, 'true', 1, '1', null];
    expect(validateRequirements(r).ok).toBe(true);
  });

  it('allows an all-events entity in retention and none outside it', () => {
    const r = base();
    const t = firstTile(r);
    t.kind = 'retention';
    t.retention = {
      target: { node: 'event', event: 'reader_opened' },
      returning: { node: 'all-events' },
    };
    expect(validateRequirements(r).ok).toBe(true);
    t.kind = 'trends';
    expect(errorPaths(r)).toEqual(['/tiles/0/retention']);
  });

  it('treats observed as optional (code-only checks)', () => {
    const r = base();
    delete r.observed;
    expect(validateRequirements(r).ok).toBe(true);
  });

  it('escapes a / in an observed event name in the error path', () => {
    const r = base();
    if (!r.observed) throw new Error('fixture changed');
    r.observed.events['shelf/added'] = { defined: false, lastSeenAt: '2026-12-01T00:00:00Z' };
    expect(errorPaths(r)).toEqual(['/observed/events/shelf~1added/lastSeenAt']);
  });

  it('reports every repeat of a duplicate id', () => {
    const r = base();
    const t = firstTile(r);
    r.tiles.push(structuredClone(t), structuredClone(t));
    expect(errorPaths(r)).toEqual(['/tiles/2/id', '/tiles/3/id']);
  });

  it('formats errors with the field path', () => {
    const r = base();
    firstTile(r).kind = 'paths';
    const result = validateRequirements(r);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(formatValidationErrors(result.errors)).toEqual([
      '/tiles/0/notChecked: a paths tile is not checked and needs a notChecked entry for the whole tile with its reason',
    ]);
  });
});
