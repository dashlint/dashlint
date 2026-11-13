import { describe, expect, it } from 'vitest';
import type { Catalog } from '../../../src/formats/catalog.js';
import { formatValidationErrors, validateCatalog } from '../../../src/formats/validate.js';
import { fixture, fixtureFiles, invalidCases } from './fixtures.js';

const base = () => structuredClone(fixture('catalog', 'valid', 'base.json')) as Catalog;

function errorPaths(data: unknown): string[] {
  const r = validateCatalog(data);
  return r.ok ? [] : r.errors.map((e) => e.path);
}

describe('dashlint.catalog/1 fixtures', () => {
  const cases = invalidCases('catalog');

  it('has an expectation for every invalid fixture and a fixture for every expectation', () => {
    expect(fixtureFiles('catalog', 'invalid')).toEqual(Object.keys(cases).sort());
  });

  it.each(fixtureFiles('catalog', 'valid'))('accepts valid/%s', (file) => {
    const r = validateCatalog(fixture('catalog', 'valid', file));
    expect(r.ok ? [] : formatValidationErrors(r.errors)).toEqual([]);
  });

  it.each(Object.entries(cases))('rejects invalid/%s and names the field', (file, c) => {
    expect(errorPaths(fixture('catalog', 'invalid', file))).toContain(c.path);
  });
});

describe('dashlint.catalog/1 rules', () => {
  it('rejects a finite set of 51 values and names the set (negative control)', () => {
    const c = base();
    const channel = c.events['wishlist_shared']?.properties['channel'];
    if (!channel) throw new Error('fixture changed');
    channel.values = { kind: 'finite', set: Array.from({ length: 51 }, (_, i) => i) };
    const r = validateCatalog(c);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(formatValidationErrors(r.errors)).toContain(
      '/events/wishlist_shared/properties/channel/values/set: must NOT have more than 50 items',
    );
  });

  it('accepts exactly 50 finite values', () => {
    const c = base();
    const channel = c.events['wishlist_shared']?.properties['channel'];
    if (!channel) throw new Error('fixture changed');
    channel.values = { kind: 'finite', set: Array.from({ length: 50 }, (_, i) => i) };
    expect(validateCatalog(c).ok).toBe(true);
  });

  it('rejects an unknown identity context and names the field (negative control)', () => {
    const c = base();
    (c.identity[0] as { context: string }).context = 'on-mount';
    const r = validateCatalog(c);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.path)).toEqual(['/identity/0/context']);
    expect(formatValidationErrors(r.errors)[0]).toMatch(
      /^\/identity\/0\/context: must be equal to one of/,
    );
  });

  it('keeps true and "true" apart, and refuses the same JSON value twice', () => {
    const c = base();
    const channel = c.events['wishlist_shared']?.properties['channel'];
    if (!channel) throw new Error('fixture changed');
    channel.values = { kind: 'finite', set: [true, 'true', 1, '1', null, 'null'] };
    expect(validateCatalog(c).ok).toBe(true);
    channel.values = { kind: 'finite', set: ['null', null, null] };
    expect(errorPaths(c)).toContain('/events/wishlist_shared/properties/channel/values/set');
    channel.values = { kind: 'finite', set: [1, 1.0] };
    expect(errorPaths(c)).toContain('/events/wishlist_shared/properties/channel/values/set');
  });

  it('never writes "no" or "unknown" presence: those are derived', () => {
    for (const presence of ['no', 'unknown', 'never']) {
      const c = base();
      const genre = c.events['wishlist_shared']?.properties['genre_id'] as { presence: string };
      genre.presence = presence;
      expect(errorPaths(c)).toEqual(['/events/wishlist_shared/properties/genre_id/presence']);
    }
  });

  it('checks the rate against literalNameSites / callSites with three-decimal rounding', () => {
    const c = base();
    c.coverage.nameResolutionRate = 58 / 61;
    expect(validateCatalog(c).ok).toBe(true);
    c.coverage.nameResolutionRate = 0.95;
    expect(errorPaths(c)).toEqual(['/coverage/nameResolutionRate']);
  });

  it('does not tie the rate to a value when there are no call sites', () => {
    const c = base();
    c.events = {};
    c.coverage = { ...c.coverage, callSites: 0, literalNameSites: 0, openSites: 0 };
    c.coverage.nameResolutionRate = 0;
    expect(validateCatalog(c).ok).toBe(true);
  });

  it('reports openSites above callSites without a rate error', () => {
    const c = base();
    c.coverage.openSites = 62;
    expect(errorPaths(c)).toEqual(['/coverage/openSites']);
  });

  it('escapes / and ~ in event names inside error paths', () => {
    const c = base();
    const event = c.events['wishlist_shared'];
    if (!event) throw new Error('fixture changed');
    c.events = { 'shelf/a~b': { ...event, openSites: 5 } };
    expect(errorPaths(c)).toEqual(['/events/shelf~1a~0b/openSites']);
  });

  it('names a missing field by its own path', () => {
    const c = base() as unknown as Record<string, unknown>;
    delete c['identity'];
    expect(errorPaths(c)).toEqual(['/identity']);
  });

  it('rejects something that is not an object at the top level', () => {
    const r = validateCatalog([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(formatValidationErrors(r.errors)).toEqual(['(top level): must be object']);
  });
});
