import { describe, expect, it } from 'vitest';
import {
  ALERT_CONDITION_DETECTOR,
  ALERT_CONDITION_UNKNOWN,
  ALERT_EMPTY_FUNNEL,
  ALERT_FUNNEL_RELATIVE,
  ALERT_FUNNEL_VIEW,
  ALERT_TARGET_HOGQL,
  ALERT_TARGET_METRICS,
  ALERT_TARGET_MISMATCH,
  ALERT_TARGET_RANGE_UNKNOWN,
  ALERT_TARGET_UNREAD,
  ALERT_TILE_MISSING,
  checkAlert,
  checkAlertTarget,
  checkAlerts,
  checkTiles,
  fireOnZero,
  posthogProfile,
  type CheckContext,
  type CodeFacts,
  type CodeIndex,
} from '../../../src/check/index.js';
import {
  eventFact,
  mergeCatalogs,
  personPropertyFact,
  propertyFact,
} from '../../../src/extract/index.js';
import type { Catalog, CatalogEvent, PropertyFact } from '../../../src/formats/catalog.js';
import type {
  Alert,
  AlertTarget,
  Filter,
  Requirements,
  SeriesNode,
  Tile,
} from '../../../src/formats/requirements.js';
import { validateCatalog } from '../../../src/formats/validate.js';

const always = (set: string[]): PropertyFact => ({
  presence: 'always',
  values: { kind: 'finite', set },
});

function event(line: number, properties: Record<string, PropertyFact>): CatalogEvent {
  return {
    sites: [
      {
        file: `src/shop${line}.ts`,
        line,
        sdk: 'shop-sdk',
        via: [],
        platforms: ['web'],
        openProperties: false,
      },
    ],
    openSites: 0,
    properties,
  };
}

/** The invented bookshop (spec 6.17): one closed web source. */
function bookshop(): Catalog {
  const c: Catalog = {
    schema: 'dashlint.catalog/1',
    tool: '0.0.0-test',
    source: {
      name: 'web',
      root: 'web',
      commit: null,
      platforms: ['web'],
      sdks: [{ id: 'shop-sdk', version: '1.0.0', types: 'stub' }],
    },
    openWorld: [],
    events: {
      wishlist_shared: event(41, { genre_id: always(['fiction', 'poetry']) }),
      order_completed: event(30, { format: always(['paperback', 'ebook']) }),
      giftcard_redeemed: event(88, {}),
    },
    superProperties: {},
    personProperties: {},
    builtins: { events: [], properties: null, conditional: ['shelf_opened'], off: [] },
    identity: [],
    coverage: {
      files: 3,
      excludedFiles: 0,
      oversizeFiles: 0,
      crashedFiles: 0,
      callSites: 10,
      literalNameSites: 10,
      openSites: 0,
      nameResolutionRate: 1,
      openSuperSites: 0,
      openPersonSites: 0,
    },
  };
  const v = validateCatalog(c);
  if (!v.ok) throw new Error(`invalid test catalog: ${JSON.stringify(v.errors)}`);
  return c;
}

function context(): CheckContext {
  const m = mergeCatalogs([bookshop()], new Map());
  const code: CodeFacts = {
    event: (n) => eventFact(m, n),
    property: (e, k) => propertyFact(m, e, k),
    personProperty: (k) => personPropertyFact(m, k),
    nameResolutionRates: m.sources.map((s) => s.catalog.coverage.nameResolutionRate),
  };
  const merged = (e: string) => (Object.hasOwn(m.events, e) ? m.events[e] : undefined);
  const index: CodeIndex = {
    events: Object.keys(m.events),
    propertyKeys: (e) => Object.keys(merged(e)?.properties ?? {}),
    personPropertyKeys: Object.keys(m.personProperties),
    sites: (e) =>
      (merged(e)?.sites ?? []).map((s) => ({ file: `${s.source}/${s.file}`, line: s.line })),
    platforms: m.platforms,
    eventPlatforms: (e) => merged(e)?.platforms ?? [],
  };
  return { facts: { code, pulledAt: '2026-12-18T09:12:00Z' }, index, profile: posthogProfile };
}

const live = 'wishlist_shared';
const live2 = 'order_completed';
const dead = 'gift_card_redeemed';
const unknownEvent = 'shelf_opened';

const ev = (name: string, filters?: Filter[]): SeriesNode => ({
  node: 'event',
  event: name,
  ...(filters === undefined ? {} : { filters }),
});

const f = (key: string, values: string[] = ['fiction']): Filter => ({
  key,
  scope: 'event',
  op: 'exact',
  values,
});

/** Series lettered A, B, ... in order. */
function trends(events: string[], extra: Partial<Tile> = {}): Tile {
  return {
    id: 'insight:shelf1',
    title: 'Shelf',
    kind: 'trends',
    series: events.map((e, i) => ({ ...ev(e), ref: String.fromCharCode(65 + i) })),
    ...extra,
  };
}

function funnel(events: string[], extra: Partial<Tile> = {}): Tile {
  return { ...trends(events, extra), kind: 'funnels' };
}

const series = (index: number): AlertTarget => ({ kind: 'series', index });
const formula = (index: number): AlertTarget => ({ kind: 'formula', index });
const step = (index: number): AlertTarget => ({ kind: 'funnel-step', index });

const UPPER = { lower: false, upper: true };
const LOWER = { lower: true, upper: false };
const BOTH = { lower: true, upper: true };
const NONE = { lower: false, upper: false };

function alert(
  target: AlertTarget,
  condition = 'absolute_value',
  bounds = UPPER,
  extra: Partial<Alert> = {},
): Alert {
  return { id: 'alert:a1', tile: 'insight:shelf1', target, condition, bounds, ...extra };
}

const run = (tile: Tile | undefined, a: Alert) => checkAlert(context(), a, tile);

describe('alert-target-valid (spec 6.7.4)', () => {
  it('a series index inside the series: valid; at or past the end: invalid target', () => {
    const tile = trends([live, live2]);
    expect(run(tile, alert(series(1)))).toMatchObject({ result: 'ok', path: 'series[1]' });
    const r = run(tile, alert(series(2)));
    expect(r).toMatchObject({ result: 'invalid-target', path: 'series[2]', causes: [] });
    expect(r.findings).toEqual([
      {
        check: 'alert-target-valid',
        path: 'series[2]',
        code: 'no',
        sites: [],
        detail: { result: 'invalid-target', target: series(2), count: 2, of: 'series' },
      },
    ]);
    expect(run(tile, alert(series(7))).result).toBe('invalid-target');
  });

  it('with formulas the index counts formula results, not series [F8]', () => {
    const tile = trends([live, live2, live], {
      formulas: [
        { index: 0, expression: 'A+B', refs: ['A', 'B'] },
        { index: 1, expression: 'C', refs: ['C'] },
      ],
    });
    expect(run(tile, alert(formula(1)))).toMatchObject({ result: 'ok', path: 'formulas[1]' });
    // Three series, but only two formula results: index 2 is out of range.
    const r = run(tile, alert(formula(2)));
    expect(r.result).toBe('invalid-target');
    expect(r.findings[0]?.detail).toMatchObject({ count: 2, of: 'formulas' });
    // One series and two formulas: index 1 exists.
    const one = trends([live], {
      formulas: [
        { index: 0, expression: 'A', refs: ['A'] },
        { index: 1, expression: 'A*2', refs: ['A'] },
      ],
    });
    expect(run(one, alert(formula(1))).result).toBe('ok');
  });

  it('an unreadable formula still counts; past it is invalid', () => {
    const tile = trends([live], {
      formulas: [{ index: 0, expression: 'A', refs: ['A'] }],
      notChecked: [{ path: 'formulas[1]', reason: 'a formula that is not text is not checked' }],
    });
    expect(run(tile, alert(formula(1)))).toMatchObject({
      result: 'not-checked',
      path: 'formulas[1]',
      reasons: ['a formula that is not text is not checked'],
    });
    expect(run(tile, alert(formula(2))).findings[0]?.detail).toMatchObject({ count: 2 });
  });

  it('a gap in the formula indexes, unread formulas or an unread tile: the range is unknown', () => {
    const gap = trends([live], {
      formulas: [
        { index: 0, expression: 'A', refs: ['A'] },
        { index: 2, expression: 'A*2', refs: ['A'] },
      ],
    });
    expect(run(gap, alert(formula(1)))).toMatchObject({
      result: 'not-checked',
      reasons: [ALERT_TARGET_RANGE_UNKNOWN],
    });
    const bare = trends([live], {
      formulas: [{ index: 0, expression: 'A', refs: ['A'] }],
      notChecked: [{ path: 'formulas', reason: 'formulas not read' }],
    });
    expect(run(bare, alert(formula(5))).reasons).toEqual([ALERT_TARGET_RANGE_UNKNOWN]);
    const whole = trends([live], { notChecked: [{ reason: 'query shape not read' }] });
    expect(run(whole, alert(series(3))).reasons).toEqual([ALERT_TARGET_RANGE_UNKNOWN]);
    // Inside the range of an unread tile: valid, but the tile itself is not checked.
    expect(run(whole, alert(series(0)))).toMatchObject({
      result: 'not-checked',
      path: 'series[0]',
      reasons: ['query shape not read'],
    });
  });

  it('an unread series past the end widens the range: inside it unknown, past it invalid', () => {
    const tile = trends([live, live2], {
      notChecked: [{ path: 'series[3]', reason: 'series not read' }],
    });
    expect(run(tile, alert(series(2))).reasons).toEqual([ALERT_TARGET_RANGE_UNKNOWN]);
    expect(run(tile, alert(series(3))).reasons).toEqual([ALERT_TARGET_RANGE_UNKNOWN]);
    expect(run(tile, alert(series(4))).findings[0]?.detail).toMatchObject({ count: 4 });
  });

  it('a funnel step against the steps (steps view, the default)', () => {
    const tile = funnel([live, live2]);
    expect(run(tile, alert(step(1))).result).toBe('ok');
    const r = run(tile, alert(step(2)));
    expect(r).toMatchObject({ result: 'invalid-target', path: 'series[2]' });
    expect(r.findings[0]?.detail).toMatchObject({ count: 2, of: 'steps' });
    expect(run({ ...tile, funnelVizType: 'steps' }, alert(step(2))).result).toBe('invalid-target');
  });

  it('the trends view reads the whole funnel, so its step index is never out of range', () => {
    const tile = funnel([live, live2], { funnelVizType: 'trends' });
    expect(run(tile, alert(step(9)))).toMatchObject({ result: 'ok', path: 'series[9]' });
  });

  it('a funnel view PostHog runs no alert on: not checked', () => {
    const tile = funnel([live, live2], { funnelVizType: 'time_to_convert' });
    expect(run(tile, alert(step(0))).reasons).toEqual([ALERT_FUNNEL_VIEW]);
  });

  it('a target that does not fit the tile: not checked', () => {
    const withFormula = trends([live], {
      formulas: [{ index: 0, expression: 'A', refs: ['A'] }],
    });
    const cases: [Tile, AlertTarget][] = [
      [trends([live]), step(0)],
      [funnel([live]), series(0)],
      [trends([live]), formula(0)],
      [withFormula, series(0)],
      [{ ...trends([live]), kind: 'lifecycle' }, series(0)],
    ];
    for (const [tile, target] of cases)
      expect(run(tile, alert(target)).reasons).toEqual([ALERT_TARGET_MISMATCH]);
  });

  it('SQL, metrics and unread targets, and a tile not in the file: not checked', () => {
    const tile = trends([dead]);
    expect(run(tile, alert({ kind: 'hogql' })).reasons).toEqual([ALERT_TARGET_HOGQL]);
    expect(run(tile, alert({ kind: 'metrics' })).reasons).toEqual([ALERT_TARGET_METRICS]);
    expect(run(tile, alert({ kind: 'other' })).reasons).toEqual([ALERT_TARGET_UNREAD]);
    expect(run(undefined, alert(series(0)))).toMatchObject({
      result: 'not-checked',
      reasons: [ALERT_TILE_MISSING],
      findings: [],
      causes: [],
    });
    expect(run(undefined, alert(series(0))).path).toBeUndefined();
  });

  it('an invalid target is reported even when the tile is dead, and stops the fire check', () => {
    const r = run(trends([dead]), alert(series(1), 'absolute_value', LOWER));
    expect(r.result).toBe('invalid-target');
    expect(r.findings.map((x) => x.check)).toEqual(['alert-target-valid']);
  });

  it('checkAlertTarget gives the watched part', () => {
    expect(checkAlertTarget(alert(series(0)), trends([live]))).toEqual({
      valid: 'yes',
      path: 'series[0]',
      watched: series(0),
    });
    const broken = trends([live], { breakdown: [{ key: 'genre_id', scope: 'event' }] });
    expect(checkAlertTarget(alert(series(0)), broken)).toMatchObject({
      watched: { kind: 'every-row' },
    });
  });
});

describe('alert-can-never-fire: every condition and bound on a dead part (spec 6.7.4)', () => {
  const table: [string, typeof UPPER, string][] = [
    ['absolute_value', UPPER, 'can-never-fire'],
    ['absolute_value', LOWER, 'fires-every-check'],
    ['absolute_value', BOTH, 'fires-every-check'],
    ['absolute_value', NONE, 'can-never-fire'],
    ['relative_increase', UPPER, 'can-never-fire'],
    ['relative_increase', LOWER, 'fires-every-check'],
    ['relative_increase', BOTH, 'fires-every-check'],
    ['relative_increase', NONE, 'can-never-fire'],
    ['relative_decrease', UPPER, 'can-never-fire'],
    ['relative_decrease', LOWER, 'fires-every-check'],
    ['relative_decrease', BOTH, 'fires-every-check'],
    ['relative_decrease', NONE, 'can-never-fire'],
  ];

  it.each(table)('%s with bounds %j: %s', (condition, bounds, expected) => {
    expect(fireOnZero({ condition, bounds }).result).toBe(expected);
    const r = run(trends([live, dead]), alert(series(1), condition, bounds));
    expect(r).toMatchObject({ result: expected, path: 'series[1]' });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      check: 'alert-can-never-fire',
      path: 'series[1]',
      code: 'no',
      detail: { result: expected, target: series(1), condition, bounds },
    });
  });

  it('negative control: an absolute lower bound on a dead part fires on every check', () => {
    const r = run(trends([dead]), alert(series(0), 'absolute_value', LOWER));
    expect(r.result).toBe('fires-every-check');
    expect(r.result).not.toBe('can-never-fire');
  });

  it.each([
    ['absolute_value', LOWER],
    ['absolute_value', UPPER],
    ['relative_increase', LOWER],
    ['relative_decrease', UPPER],
    ['detector', NONE],
    ['some_new_condition', UPPER],
  ])('a live target with %s %j: ok, no finding', (condition, bounds) => {
    const r = run(trends([live, dead]), alert(series(0), condition, bounds));
    expect(r).toMatchObject({ result: 'ok', path: 'series[0]', findings: [], causes: [] });
    expect(r.reasons).toBeUndefined();
  });

  it('detector alerts on a dead part: not checked; so is a condition dashlint does not know', () => {
    const tile = trends([dead]);
    expect(run(tile, alert(series(0), 'detector', NONE))).toMatchObject({
      result: 'not-checked',
      path: 'series[0]',
      reasons: [ALERT_CONDITION_DETECTOR],
    });
    expect(run(tile, alert(series(0), 'other', UPPER)).reasons).toEqual([ALERT_CONDITION_UNKNOWN]);
    expect(fireOnZero({ condition: 'detector', bounds: LOWER })).toEqual({
      result: 'unknown',
      reason: ALERT_CONDITION_DETECTOR,
    });
  });

  it('a degraded target is ok; an unknown one is not checked with its reasons', () => {
    // A negative filter on a key the event never sends has no effect: degraded (spec 6.7.2).
    const noEffect: Filter = { key: 'format', scope: 'event', op: 'is_not', values: ['x'] };
    const tile: Tile = { ...trends([live]), series: [{ ...ev(live, [noEffect]), ref: 'A' }] };
    expect(run(tile, alert(series(0), 'absolute_value', LOWER)).result).toBe('ok');
    const unknown = run(trends([unknownEvent]), alert(series(0), 'absolute_value', LOWER));
    expect(unknown.result).toBe('not-checked');
    expect(unknown.reasons?.length).toBeGreaterThan(0);
  });

  it('the causes are the dead findings of the target, and the sites come from them', () => {
    const r = run(trends([live, dead]), alert(series(1)));
    expect(r.causes).toHaveLength(1);
    expect(r.causes[0]).toMatchObject({ check: 'event-has-call-site', path: 'series[1]' });
    expect(r.findings[0]?.sites).toEqual(r.causes[0]?.sites);
    // A dead filter on the tile kills every series: it is a cause too.
    const filtered = run(trends([live], { filters: [f('genre')] }), alert(series(0)));
    expect(filtered.result).toBe('can-never-fire');
    expect(filtered.causes.map((c) => c.path)).toEqual(['filters[0]']);
    // A dead series the alert does not watch is not a cause.
    const other = run(trends([dead, dead]), alert(series(0)));
    expect(other.causes.map((c) => c.path)).toEqual(['series[0]']);
  });

  it('sites are listed once when two causes share them', () => {
    const tile = trends([live], { filters: [f('genre'), f('genre', ['poetry'])] });
    const r = run(tile, alert(series(0)));
    expect(r.causes).toHaveLength(2);
    const keys = r.findings[0]?.sites.map((s) => `${s.file}:${String(s.line)}`) ?? [];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('formulas', () => {
  const ab = (expression: string) =>
    trends([live, dead], { formulas: [{ index: 0, expression, refs: ['A', 'B'] }] });

  it('A/B with B dead: the formula result is dead, so the alert can never fire', () => {
    const r = run(ab('A/B'), alert(formula(0)));
    expect(r).toMatchObject({ result: 'can-never-fire', path: 'formulas[0]' });
    expect(r.causes.map((c) => c.path)).toEqual(['series[1]']);
  });

  it('A+B with B dead is partly dead, not constant: ok', () => {
    expect(run(ab('A+B'), alert(formula(0), 'absolute_value', LOWER)).result).toBe('ok');
  });

  it('a dead series a live formula ignores does not matter', () => {
    const tile = trends([live, dead], { formulas: [{ index: 0, expression: 'A*2', refs: ['A'] }] });
    expect(run(tile, alert(formula(0))).result).toBe('ok');
  });

  it('the inputs also come from the expression when refs leave a letter out', () => {
    const tile = trends([live, dead], { formulas: [{ index: 0, expression: 'B*2', refs: [] }] });
    const r = run(tile, alert(formula(0)));
    expect(r.result).toBe('can-never-fire');
    expect(r.causes.map((c) => c.path)).toEqual(['series[1]']);
  });

  it('a formula that does not parse leaves the alert not checked', () => {
    const tile = trends([dead], { formulas: [{ index: 0, expression: 'A ^ 2', refs: ['A'] }] });
    expect(run(tile, alert(formula(0))).result).toBe('not-checked');
  });
});

describe('breakdowns: the alert reads every row (ADR-041)', () => {
  const by = { breakdown: [{ key: 'genre_id', scope: 'event' as const }] };

  it('a dead target next to a live series is not constant: ok', () => {
    expect(run(trends([live, dead], by), alert(series(1))).result).toBe('ok');
  });

  it('every series dead: can never fire, watching every row', () => {
    const r = run(trends([dead, dead], by), alert(series(0), 'relative_decrease', UPPER));
    expect(r.result).toBe('can-never-fire');
    expect(r.findings[0]?.detail.watches).toBe('every-row');
    expect(r.causes.map((c) => c.path)).toEqual(['series[0]', 'series[1]']);
  });

  it('dead and unknown series: not checked', () => {
    const r = run(trends([dead, unknownEvent], by), alert(series(0)));
    expect(r.result).toBe('not-checked');
  });

  it('formulas with a breakdown: every formula row counts', () => {
    const tile = trends([dead, live], {
      ...by,
      formulas: [
        { index: 0, expression: 'A', refs: ['A'] },
        { index: 1, expression: 'B', refs: ['B'] },
      ],
    });
    expect(run(tile, alert(formula(0))).result).toBe('ok');
  });

  it('an unread breakdown is still a breakdown', () => {
    const tile = trends([live, dead], {
      notChecked: [{ path: 'breakdown', reason: 'a dashboard may replace it' }],
    });
    expect(run(tile, alert(series(1))).result).toBe('ok');
  });
});

describe('funnels', () => {
  it('steps view: a step before the first dead step is ok; from it on the conversion is zero', () => {
    const tile = funnel([live, live2, dead]);
    expect(run(tile, alert(step(1), 'absolute_value', LOWER)).result).toBe('ok');
    expect(run(tile, alert(step(2), 'absolute_value', UPPER)).result).toBe('can-never-fire');
    const r = run(tile, alert(step(2), 'absolute_value', LOWER));
    expect(r.result).toBe('fires-every-check');
    expect(r.causes.map((c) => c.path)).toEqual(['series[2]']);
  });

  it('a dead step before the watched one makes it zero too', () => {
    const tile = funnel([live, dead, live2]);
    expect(run(tile, alert(step(2))).result).toBe('can-never-fire');
  });

  it('first step dead: an upper bound never fires; a lower one is unknown (no value to read)', () => {
    const tile = funnel([dead, live]);
    expect(run(tile, alert(step(1), 'absolute_value', UPPER)).result).toBe('can-never-fire');
    expect(run(tile, alert(step(1), 'absolute_value', LOWER))).toMatchObject({
      result: 'not-checked',
      path: 'series[1]',
      reasons: [ALERT_EMPTY_FUNNEL],
    });
  });

  it('steps view with a relative condition: PostHog cannot evaluate it', () => {
    const tile = funnel([dead, live]);
    expect(run(tile, alert(step(1), 'relative_increase', UPPER)).reasons).toEqual([
      ALERT_FUNNEL_RELATIVE,
    ]);
  });

  it('an unknown step and no dead one: not checked', () => {
    const r = run(funnel([live, unknownEvent]), alert(step(1)));
    expect(r.result).toBe('not-checked');
  });

  it('trends view: any dead step makes the whole conversion zero; relative works', () => {
    const tile = funnel([live, dead], { funnelVizType: 'trends' });
    const up = run(tile, alert(step(0), 'relative_decrease', UPPER));
    expect(up.result).toBe('can-never-fire');
    expect(up.findings[0]?.detail.watches).toBe('funnel');
    expect(run(tile, alert(step(0), 'relative_increase', LOWER)).result).toBe('fires-every-check');
    expect(run(funnel([live, live2], { funnelVizType: 'trends' }), alert(step(0))).result).toBe(
      'ok',
    );
    const empty = funnel([dead, live], { funnelVizType: 'trends' });
    expect(run(empty, alert(step(0), 'absolute_value', LOWER)).reasons).toEqual([
      ALERT_EMPTY_FUNNEL,
    ]);
  });
});

describe('PostHog state, dashboards and checkAlerts', () => {
  it('state and enabled are carried as PostHog shows them; a missing state is null', () => {
    const r = run(
      trends([dead]),
      alert(series(0), 'absolute_value', UPPER, {
        name: 'Gift cards',
        state: 'Errored',
        enabled: false,
      }),
    );
    expect(r).toMatchObject({
      id: 'alert:a1',
      name: 'Gift cards',
      tile: 'insight:shelf1',
      result: 'can-never-fire',
      state: 'Errored',
      enabled: false,
    });
    const bare = run(trends([dead]), alert(series(0)));
    expect(bare.state).toBeNull();
    expect('enabled' in bare).toBe(false);
    expect('name' in bare).toBe(false);
  });

  it('alerts run on the insight: a dashboard filter that kills the tile does not apply', () => {
    const requirements: Requirements = {
      schema: 'dashlint.requirements/1',
      source: { platform: 'posthog' },
      dashboards: [{ id: 'dash:1', filters: [f('genre')] }],
      tiles: [trends([live], { dashboards: ['dash:1'] })],
      alerts: [alert(series(0), 'absolute_value', LOWER)],
    };
    const ctx = context();
    expect(checkTiles(ctx, requirements)[0]?.verdict).toBe('dead');
    expect(checkAlerts(ctx, requirements)[0]?.result).toBe('ok');
  });

  it('checkAlerts keeps the order, checks each tile once and handles missing tiles', () => {
    const requirements: Requirements = {
      schema: 'dashlint.requirements/1',
      source: { platform: 'posthog' },
      tiles: [trends([live, dead]), { ...trends([live]), id: 'insight:paths', kind: 'paths' }],
      alerts: [
        alert(series(1), 'absolute_value', UPPER, { id: 'alert:a' }),
        alert(series(0), 'absolute_value', UPPER, { id: 'alert:b' }),
        alert(series(0), 'absolute_value', UPPER, { id: 'alert:c', tile: 'insight:gone' }),
        alert(series(0), 'absolute_value', UPPER, { id: 'alert:d', tile: 'insight:paths' }),
      ],
    };
    expect(checkAlerts(context(), requirements).map((a) => [a.id, a.result, a.reasons])).toEqual([
      ['alert:a', 'can-never-fire', undefined],
      ['alert:b', 'ok', undefined],
      ['alert:c', 'not-checked', [ALERT_TILE_MISSING]],
      ['alert:d', 'not-checked', [ALERT_TARGET_MISMATCH]],
    ]);
    expect(checkAlerts(context(), { ...requirements, alerts: undefined })).toEqual([]);
  });

  it('a result passed in is used as is', () => {
    const tile = trends([dead]);
    const given = checkTiles(context(), {
      schema: 'dashlint.requirements/1',
      source: { platform: 'posthog' },
      tiles: [tile],
    })[0];
    const r = checkAlert(context(), alert(series(0)), tile, given);
    expect(r.result).toBe('can-never-fire');
  });
});
