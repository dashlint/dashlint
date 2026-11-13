import { describe, expect, it } from 'vitest';
import {
  IGNORE_EXPIRED,
  IGNORE_UNMATCHED,
  applyIgnore,
  expired,
  parseIgnore,
  type AlertCheckResult,
  type IgnoreEntry,
  type TileResult,
  type TileVerdict,
} from '../../../src/check/index.js';
import type { Requirements } from '../../../src/formats/requirements.js';

const NOW = new Date('2026-12-18T09:12:00Z');

/** The invented bookshop (spec 6.17): two dashboards, three tiles, two alerts. */
const requirements: Requirements = {
  schema: 'dashlint.requirements/1',
  source: { platform: 'posthog' },
  dashboards: [{ id: 'dashboard:7' }, { id: 'dashboard:9' }],
  tiles: [
    { id: 'insight:Wish01', title: 'Wishlist shares', kind: 'trends', dashboards: ['dashboard:7'] },
    { id: 'insight:Gift02', title: 'Gift cards', kind: 'trends', dashboards: ['dashboard:9'] },
    { id: 'insight:Ord03', title: 'Orders', kind: 'trends' },
  ],
  alerts: [
    {
      id: 'alert:a1',
      tile: 'insight:Gift02',
      target: { kind: 'series', index: 0 },
      condition: 'absolute_value',
      bounds: { lower: false, upper: true },
    },
    {
      id: 'alert:a2',
      tile: 'insight:Ord03',
      target: { kind: 'series', index: 0 },
      condition: 'absolute_value',
      bounds: { lower: false, upper: true },
    },
  ],
};

const tile = (id: string, verdict: TileVerdict = 'dead'): TileResult => ({
  id,
  kind: 'trends',
  verdict,
  platforms: [],
  parts: [],
  series: [],
  findings: [],
  unknownParts: [],
});

const alert = (id: string, on: string): AlertCheckResult => ({
  id,
  tile: on,
  result: 'can-never-fire',
  state: null,
  findings: [],
  causes: [],
});

const tiles = [tile('insight:Wish01'), tile('insight:Gift02', 'live'), tile('insight:Ord03')];
const alerts = [alert('alert:a1', 'insight:Gift02'), alert('alert:a2', 'insight:Ord03')];

function entries(raw: unknown): IgnoreEntry[] {
  const r = parseIgnore(raw);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
}

describe('parseIgnore (spec 6.8)', () => {
  it('reads tile, alert and dashboard entries, adding the id prefix to a bare id', () => {
    expect(
      entries([
        { tile: 'insight:Wish01', reason: ' retired on purpose ', until: '2027-06-30' },
        { tile: 'Ord03', reason: 'old' },
        { dashboard: 7, reason: 'archive' },
        { alert: 'a1', reason: 'noisy' },
      ]),
    ).toEqual([
      { kind: 'tile', id: 'insight:Wish01', reason: 'retired on purpose', until: '2027-06-30' },
      { kind: 'tile', id: 'insight:Ord03', reason: 'old' },
      { kind: 'dashboard', id: 'dashboard:7', reason: 'archive' },
      { kind: 'alert', id: 'alert:a1', reason: 'noisy' },
    ]);
  });

  it('an absent list is empty', () => {
    expect(parseIgnore(undefined)).toEqual({ ok: true, value: [] });
    expect(parseIgnore(null)).toEqual({ ok: true, value: [] });
  });

  it('names every bad entry and key', () => {
    const r = parseIgnore([
      { tile: 'insight:Wish01' },
      { tile: 'a', dashboard: 'b', reason: 'x' },
      { reason: 'x' },
      { tile: '  ', reason: 'x' },
      { tile: 'a', reason: 'x', until: '2027-02-30' },
      { tile: 'a', reason: 'x', until: 20270630 },
      { tile: 'a', reason: 'x', untill: '2027-06-30' },
      'insight:Wish01',
      { tile: 1.5, reason: 'x' },
    ]);
    expect(r).toEqual({
      ok: false,
      errors: [
        'ignore[0].reason: say why the tile is ignored',
        'ignore[1]: give exactly one of tile, alert or dashboard',
        'ignore[2]: give exactly one of tile, alert or dashboard',
        'ignore[3].tile: must be a non-empty id',
        'ignore[4].until: must be a date written YYYY-MM-DD',
        'ignore[5].until: must be a date written YYYY-MM-DD',
        'ignore[6].untill: unknown key',
        'ignore[7]: must be a mapping',
        'ignore[8].tile: must be a non-empty id',
      ],
    });
    expect(parseIgnore({ tile: 'a' })).toEqual({ ok: false, errors: ['ignore: must be a list'] });
  });
});

describe('applyIgnore (spec 6.7.3)', () => {
  it('a tile entry moves the tile to ignored and keeps its own result', () => {
    const o = applyIgnore(
      requirements,
      tiles,
      alerts,
      entries([{ tile: 'Wish01', reason: 'r' }]),
      NOW,
    );
    expect(o.tiles.map((t) => t.verdict)).toEqual(['ignored', 'live', 'dead']);
    expect(o.tiles[0]).toMatchObject({
      result: { verdict: 'dead' },
      ignored: { index: 0, entry: { kind: 'tile', id: 'insight:Wish01' } },
    });
    expect(o.tiles[2]?.ignored).toBeUndefined();
    expect(o.warnings).toEqual([]);
  });

  it('a dashboard entry ignores every tile on it, and the alerts on those tiles', () => {
    const o = applyIgnore(
      requirements,
      tiles,
      alerts,
      entries([{ dashboard: 9, reason: 'r' }]),
      NOW,
    );
    expect(o.tiles.map((t) => t.verdict)).toEqual(['dead', 'ignored', 'dead']);
    expect(o.alerts.map((a) => a.ignored?.entry.id)).toEqual(['dashboard:9', undefined]);
  });

  it('an alert entry ignores the alert only', () => {
    const o = applyIgnore(
      requirements,
      tiles,
      alerts,
      entries([{ alert: 'a2', reason: 'r' }]),
      NOW,
    );
    expect(o.tiles.map((t) => t.verdict)).toEqual(['dead', 'live', 'dead']);
    expect(o.alerts.map((a) => a.ignored?.entry.id)).toEqual([undefined, 'alert:a2']);
  });

  it('holds through its until day; after it the tile returns with a warning', () => {
    const e = entries([{ tile: 'Wish01', reason: 'r', until: '2026-12-18' }]);
    expect(applyIgnore(requirements, tiles, alerts, e, NOW).tiles[0]?.verdict).toBe('ignored');
    expect(expired(e[0] as IgnoreEntry, NOW)).toBe(false);
    const late = new Date('2026-12-19T00:00:00Z');
    const o = applyIgnore(requirements, tiles, alerts, e, late);
    expect(o.tiles[0]).toEqual({ result: tiles[0], verdict: 'dead' });
    expect(o.warnings).toEqual([{ code: IGNORE_EXPIRED, index: 0, entry: e[0] }]);
    expect(expired(e[0] as IgnoreEntry, late)).toBe(true);
  });

  it('an entry naming nothing warns in config order and ignores nothing', () => {
    const e = entries([
      { tile: 'Gone99', reason: 'r' },
      { tile: 'Wish01', reason: 'r', until: '2026-01-01' },
      { dashboard: 'dashboard:7', reason: 'r' },
      { alert: 'zz', reason: 'r' },
      { dashboard: 'dashboard:404', reason: 'r' },
    ]);
    const o = applyIgnore(requirements, tiles, alerts, e, NOW);
    expect(o.warnings.map((w) => [w.code, w.index])).toEqual([
      [IGNORE_UNMATCHED, 0],
      [IGNORE_EXPIRED, 1],
      [IGNORE_UNMATCHED, 3],
      [IGNORE_UNMATCHED, 4],
    ]);
    // The expired tile entry does not count; the dashboard entry still ignores the tile.
    expect(o.tiles[0]?.ignored?.index).toBe(2);
  });

  it('no entries: every verdict is the tile own, nothing is ignored', () => {
    const o = applyIgnore(requirements, tiles, alerts, [], NOW);
    expect(o.tiles.map((t) => t.verdict)).toEqual(['dead', 'live', 'dead']);
    expect(o.alerts.every((a) => a.ignored === undefined)).toBe(true);
  });
});
