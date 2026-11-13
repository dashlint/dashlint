// T5.4 (spec 6.5.1, 6.5.2, 6.5.4): action steps with the matchers dashlint cannot check, alerts
// without values (no threshold number, `last_value` or check history ever reaches the
// requirements), and the observed data PostHog's definitions give for what the tiles reference.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dropOnArrival } from '../../../../src/adapters/posthog/client.js';
import {
  actionIdsOf,
  actionLookup,
  normalizeAction,
  normalizeAlerts,
  normalizeInsights,
  observedEvent,
  observedOf,
  referencesOf,
  withObserved,
  type NormalizeContext,
} from '../../../../src/adapters/posthog/normalize/index.js';
import { toCanonicalJson } from '../../../../src/formats/canonical.js';
import type { Observed, Requirements, Tile } from '../../../../src/formats/requirements.js';
import { validateRequirements } from '../../../../src/formats/validate.js';

type Raw = Record<string, unknown>;

const ctx: NormalizeContext = { host: 'https://us.posthog.com', project: 1001 };

function expectValid(r: Requirements): void {
  const v = validateRequirements(r);
  expect(v.ok ? [] : v.errors).toEqual([]);
}

let nextId = 1;
function insight(source: Raw, extra: Raw = {}): Raw {
  const id = nextId++;
  return {
    id,
    short_id: `BkT5${String(id).padStart(4, '0')}`,
    name: `Insight ${id}`,
    query: { kind: 'InsightVizNode', source },
    ...extra,
  };
}

const ev = (event: string, extra: Raw = {}): Raw => ({ kind: 'EventsNode', event, ...extra });
const trends = (series: unknown[], extra: Raw = {}): Raw => ({
  kind: 'TrendsQuery',
  series,
  ...extra,
});

const NULL_MATCHERS: Raw = {
  selector: null,
  selector_regex: null,
  selector_warning: null,
  tag_name: null,
  text: null,
  text_matching: null,
  href: null,
  href_matching: null,
  url: null,
  url_matching: null,
};

// ---------- actions ----------

describe('actions', () => {
  it('expands steps; url, href, selector, tag and text matchers are unsupported', () => {
    const action = normalizeAction({
      id: 12,
      name: 'Bought a book',
      steps: [
        { ...NULL_MATCHERS, event: 'order_completed', properties: null },
        {
          ...NULL_MATCHERS,
          event: 'order_completed_native',
          properties: [{ key: 'total', type: 'event', operator: 'gt', value: 0 }],
        },
        { ...NULL_MATCHERS, event: '$pageview', url: '/thanks', url_matching: 'contains' },
        { ...NULL_MATCHERS, event: '$autocapture', href: '/cart', selector: 'button.buy' },
        { ...NULL_MATCHERS, event: '$autocapture', tag_name: 'a', text: 'Buy' },
        // A `*_matching` mode alone, or a derived selector field, matches nothing on its own.
        {
          ...NULL_MATCHERS,
          event: 'cart_viewed',
          url_matching: 'contains',
          text_matching: 'exact',
        },
        { ...NULL_MATCHERS, event: 'cart_viewed', selector_regex: 'x', selector_warning: 'w' },
      ],
    });
    expect(action).toEqual({
      id: 12,
      name: 'Bought a book',
      steps: [
        { event: 'order_completed', filters: [] },
        {
          event: 'order_completed_native',
          filters: [{ key: 'total', scope: 'event', op: 'gt', values: [0] }],
        },
        { event: '$pageview', filters: [], unsupported: ['url'] },
        { event: '$autocapture', filters: [], unsupported: ['href', 'selector'] },
        { event: '$autocapture', filters: [], unsupported: ['tag_name', 'text'] },
        { event: 'cart_viewed', filters: [] },
        { event: 'cart_viewed', filters: [] },
      ],
    });
  });

  it('reads a null or empty step event as every event; other step shapes are unsupported', () => {
    const action = normalizeAction({
      id: '5',
      steps: [
        { event: null },
        { event: '' },
        { event: 42 },
        'not a step',
        { event: 'a', properties: [{ type: 'event', key: 'k', value: { nested: true } }] },
        { event: 'b', properties: 'not a list' },
      ],
    });
    expect(action).toEqual({
      id: '5',
      steps: [
        { event: null, filters: [] },
        { event: null, filters: [] },
        { event: null, filters: [], unsupported: ['event'] },
        { event: null, filters: [], unsupported: ['step'] },
        { event: 'a', filters: [], unsupported: ['properties'] },
        { event: 'b', filters: [], unsupported: ['properties'] },
      ],
    });
  });

  it('is not an action without an id or a list of steps', () => {
    for (const body of [
      null,
      [],
      'x',
      { steps: [] },
      { id: '', steps: [] },
      { id: Number.NaN, steps: [] },
      { id: true, steps: [] },
      { id: 3 },
      { id: 3, steps: null },
    ])
      expect(normalizeAction(body)).toBeUndefined();
    expect(normalizeAction({ id: 3, name: '', steps: [] })).toEqual({ id: 3, steps: [] });
  });

  it('looks actions up by id as text; the first body of an id wins', () => {
    const lookup = actionLookup([
      { id: 7, name: 'First', steps: [] },
      { id: '7', name: 'Second', steps: [] },
      { id: 8, steps: 'no' },
      null,
    ]);
    expect(lookup(7)?.name).toBe('First');
    expect(lookup('7')?.name).toBe('First');
    expect(lookup(8)).toBeUndefined();
    expect(lookup(9)).toBeUndefined();
  });

  it('expands series, funnel exclusions and retention entities, and lists their ids', () => {
    const lookup = actionLookup([
      { id: 30, name: 'Thirty', steps: [{ event: 'book_viewed' }] },
      { id: 4, name: 'Four', steps: [{ event: 'order_completed' }] },
    ]);
    const insights = [
      insight(
        trends([
          { kind: 'ActionsNode', id: 30 },
          { kind: 'ActionsNode', id: 99 },
        ]),
      ),
      insight({
        kind: 'FunnelsQuery',
        series: [ev('cart_viewed'), ev('order_completed')],
        funnelsFilter: {
          exclusions: [{ kind: 'ActionsNode', id: 4, funnelFromStep: 0, funnelToStep: 1 }],
        },
      }),
      insight({
        kind: 'RetentionQuery',
        retentionFilter: {
          targetEntity: { type: 'actions', id: 4 },
          returningEntity: { type: 'actions', id: '30' },
        },
      }),
    ];
    const r = normalizeInsights(insights, { ...ctx, actions: lookup });
    expectValid(r);
    const [t, f, ret] = r.tiles as [Tile, Tile, Tile];
    expect(t.series?.[0]).toMatchObject({ node: 'action', action: { id: 30, name: 'Thirty' } });
    expect(t.notChecked).toEqual([{ path: 'series[1]', reason: 'action 99 was not read' }]);
    expect(f.exclusions?.[0]).toMatchObject({ action: { id: 4, name: 'Four' }, fromStep: 0 });
    expect(ret.retention?.target).toMatchObject({ action: { id: 4, name: 'Four' } });
    expect(ret.retention?.returning).toMatchObject({ action: { id: 30, name: 'Thirty' } });
    expect(f.notChecked).toEqual([]);
    expect(ret.notChecked).toEqual([]);
    // Without the lookup, the ids pull must read; once each, sorted as text.
    expect(actionIdsOf(normalizeInsights(insights, ctx))).toEqual([30, 4, 99]);
  });
});

// ---------- alerts ----------

const SECRET_VALUES = [0.123456, 987654, 13579.5, 24680];

function alert(extra: Raw = {}): Raw {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    name: 'Shares dropped',
    insight: { id: 1, short_id: 'BkT5Alrt', name: 'Shares' },
    enabled: true,
    state: 'Not firing',
    condition: { type: 'relative_decrease' },
    threshold: {
      id: 'th',
      configuration: { type: 'percentage', bounds: { lower: 0.123456, upper: 987654 } },
    },
    config: { type: 'TrendsAlertConfig', series_index: 0, check_ongoing_interval: false },
    calculation_interval: 'daily',
    detector_config: null,
    last_value: 13579.5,
    checks_total: 1,
    checks: [{ id: 'c1', calculated_value: 24680, state: 'Firing', error: null }],
    ...extra,
  };
}

const alertInsights = (): Raw[] => [
  { ...insight(trends([ev('wishlist_shared')])), id: 1, short_id: 'BkT5Alrt' },
  {
    ...insight(
      trends([ev('wishlist_shared'), ev('review_shared')], {
        trendsFilter: { formulaNodes: [{ formula: 'A+B' }] },
      }),
    ),
    id: 2,
    short_id: 'BkT5Form',
  },
  {
    ...insight({ kind: 'FunnelsQuery', series: [ev('a'), ev('b'), ev('c')] }),
    id: 3,
    short_id: 'BkT5Funl',
  },
  {
    ...insight(trends([ev('x')], { trendsFilter: { formulaNodes: [{ formula: 42 }] } })),
    id: 4,
    short_id: 'BkT5Bad',
  },
];

function alertsOf(alerts: Raw[], insights: Raw[] = alertInsights()): Requirements {
  const r = normalizeInsights(insights, { ...ctx, alerts });
  expectValid(r);
  return r;
}

describe('alerts', () => {
  it('negative control: no threshold number, last_value or check history reaches the requirements', () => {
    // Straight from the response, without the client's drop on arrival, and after it.
    for (const raw of [alert(), dropOnArrival(alert()) as Raw]) {
      const text = toCanonicalJson(alertsOf([raw]));
      for (const v of SECRET_VALUES) expect(text).not.toContain(String(v));
      for (const k of ['last_value', 'checks', 'threshold', 'calculated_value', 'configuration'])
        expect(text).not.toContain(`"${k}"`);
      expect(alertsOf([raw]).alerts).toEqual([
        {
          id: 'alert:00000000-0000-4000-8000-0000000000a1',
          name: 'Shares dropped',
          tile: 'insight:BkT5Alrt',
          target: { kind: 'series', index: 0 },
          condition: 'relative_decrease',
          bounds: { lower: true, upper: true },
          interval: 'daily',
          enabled: true,
          state: 'Not firing',
        },
      ]);
    }
  });

  it('every key an alert can carry is one the format allows, so no value has a place to go', () => {
    const [a] = alertsOf([alert()]).alerts ?? [];
    expect(Object.keys(a ?? {}).sort()).toEqual(
      [
        'bounds',
        'condition',
        'enabled',
        'id',
        'interval',
        'name',
        'state',
        'target',
        'tile',
      ].sort(),
    );
    expect(Object.values(a?.bounds ?? {}).every((b) => typeof b === 'boolean')).toBe(true);
  });

  it('targets a series, or the formula result when the insight has a formula', () => {
    const r = alertsOf([
      alert({ id: 'a1', insight: { id: 2, short_id: 'BkT5Form' } }),
      alert({
        id: 'a2',
        insight: { id: 4 },
        config: { type: 'TrendsAlertConfig', series_index: 0 },
      }),
      alert({ id: 'a3', config: { type: 'TrendsAlertConfig', series_index: 5 } }),
      alert({ id: 'a4', config: { type: 'TrendsAlertConfig', series_index: -1 } }),
      alert({ id: 'a5', config: { type: 'TrendsAlertConfig', series_index: 1.5 } }),
      alert({ id: 'a6', config: { type: 'TrendsAlertConfig' } }),
    ]);
    expect(r.alerts?.map((a) => [a.id, a.tile, a.target])).toEqual([
      ['alert:a1', 'insight:BkT5Form', { kind: 'formula', index: 0 }],
      // An unreadable formula is still a formula.
      ['alert:a2', 'insight:BkT5Bad', { kind: 'formula', index: 0 }],
      // Out of range is kept (the alert-target-valid check reports it).
      ['alert:a3', 'insight:BkT5Alrt', { kind: 'series', index: 5 }],
      ['alert:a4', 'insight:BkT5Alrt', { kind: 'other' }],
      ['alert:a5', 'insight:BkT5Alrt', { kind: 'other' }],
      ['alert:a6', 'insight:BkT5Alrt', { kind: 'other' }],
    ]);
  });

  it('targets a funnel step; a null step is the last step', () => {
    const funnel = { id: 3, short_id: 'BkT5Funl' };
    const r = alertsOf([
      alert({ id: 'f1', insight: funnel, config: { type: 'FunnelsAlertConfig', funnel_step: 1 } }),
      alert({
        id: 'f2',
        insight: funnel,
        config: { type: 'FunnelsAlertConfig', funnel_step: null },
      }),
      alert({ id: 'f3', insight: funnel, config: { type: 'FunnelsAlertConfig', metric: 'x' } }),
      alert({
        id: 'f4',
        insight: funnel,
        config: { type: 'FunnelsAlertConfig', funnel_step: 'a' },
      }),
      // A null step on a tile with no steps, or that is not a funnel, has no last step.
      alert({ id: 'f5', config: { type: 'FunnelsAlertConfig', funnel_step: null } }),
      alert({ id: 'f6', config: { type: 'FunnelsAlertConfig', funnel_step: 2 } }),
    ]);
    expect(r.alerts?.map((a) => a.target)).toEqual([
      { kind: 'funnel-step', index: 1 },
      { kind: 'funnel-step', index: 2 },
      { kind: 'funnel-step', index: 2 },
      { kind: 'other' },
      { kind: 'other' },
      { kind: 'funnel-step', index: 2 },
    ]);
    const empty = alertsOf(
      [alert({ id: 'f7', insight: { id: 9 }, config: { type: 'FunnelsAlertConfig' } })],
      [{ ...insight({ kind: 'FunnelsQuery', series: [] }), id: 9, short_id: 'BkT5None' }],
    );
    expect(empty.alerts?.[0]?.target).toEqual({ kind: 'other' });
  });

  it('names HogQL and metrics alerts; any other config is other', () => {
    const r = alertsOf([
      alert({ id: 'h', config: { type: 'HogQLAlertConfig', evaluation: 'any_row' } }),
      alert({ id: 'm', config: { type: 'MetricsAlertConfig' } }),
      alert({ id: 'n', config: null }),
      alert({ id: 'o', config: { type: 'SomethingNewAlertConfig', series_index: 0 } }),
      alert({ id: 'p', config: 'TrendsAlertConfig' }),
    ]);
    expect(r.alerts?.map((a) => a.target.kind)).toEqual([
      'hogql',
      'metrics',
      'other',
      'other',
      'other',
    ]);
  });

  it('reads the condition; a detector decides instead of a threshold', () => {
    const r = alertsOf([
      alert({ id: 'c1', condition: { type: 'absolute_value' } }),
      alert({ id: 'c2', condition: { type: 'Relative_Increase' } }),
      alert({ id: 'c3', condition: null }),
      alert({ id: 'c4', condition: { type: 'not a name!' } }),
      alert({ id: 'c5', detector_config: { type: 'zscore', threshold: 0.9 } }),
    ]);
    expect(r.alerts?.map((a) => a.condition)).toEqual([
      'absolute_value',
      'relative_increase',
      'other',
      'other',
      'detector',
    ]);
    expect(toCanonicalJson(r)).not.toContain('zscore');
  });

  it('records which bounds exist, never their values', () => {
    const bounds = (b: unknown): Raw => ({ configuration: { type: 'absolute', bounds: b } });
    const r = alertsOf([
      alert({ id: 'b1', threshold: bounds({ lower: 0 }) }),
      alert({ id: 'b2', threshold: bounds({ upper: -3, lower: null }) }),
      alert({ id: 'b3', threshold: bounds(null) }),
      alert({ id: 'b4', threshold: null }),
      alert({ id: 'b5', threshold: { configuration: null } }),
      alert({ id: 'b6', threshold: bounds({ lower: '5', upper: true }) }),
    ]);
    expect(r.alerts?.map((a) => a.bounds)).toEqual([
      { lower: true, upper: false },
      { lower: false, upper: true },
      { lower: false, upper: false },
      { lower: false, upper: false },
      { lower: false, upper: false },
      { lower: false, upper: false },
    ]);
  });

  it('keeps interval, enabled and state only when they have their type', () => {
    const r = alertsOf([
      alert({ id: 's1', state: null, enabled: false, calculation_interval: 'weekly' }),
      alert({ id: 's2', state: 3, enabled: 'yes', calculation_interval: 'every 15 min', name: '' }),
    ]);
    expect(r.alerts).toEqual([
      expect.objectContaining({ state: null, enabled: false, interval: 'weekly' }),
      {
        id: 'alert:s2',
        tile: 'insight:BkT5Alrt',
        target: { kind: 'series', index: 0 },
        condition: 'relative_decrease',
        bounds: { lower: true, upper: true },
      },
    ]);
  });

  it('names the tile of an insight that is not saved by its short id; leaves out alerts with no id or insight', () => {
    const r = alertsOf([
      alert({ id: 'u1', insight: { id: 777, short_id: 'GoneAway' } }),
      alert({ id: 'u2', insight: 778, insight_short_id: 'GoneToo' }),
      alert({ id: 'u3', insight: 779 }),
      alert({ id: 'u4', insight: null }),
      alert({ id: '' }),
      alert({ id: null }),
      'not an alert',
    ]);
    expect(r.alerts?.map((a) => [a.id, a.tile, a.target])).toEqual([
      ['alert:u1', 'insight:GoneAway', { kind: 'other' }],
      ['alert:u2', 'insight:GoneToo', { kind: 'other' }],
      ['alert:u3', 'insight:779', { kind: 'other' }],
    ]);
  });

  it('sorts alerts by id; the first alert of an id wins', () => {
    const r = alertsOf([
      alert({ id: 'b', name: 'first b' }),
      alert({ id: 'a' }),
      alert({ id: 'b', name: 'second b' }),
      alert({ id: 10 }),
    ]);
    expect(r.alerts?.map((a) => [a.id, a.name])).toEqual([
      ['alert:10', 'Shares dropped'],
      ['alert:a', 'Shares dropped'],
      ['alert:b', 'first b'],
    ]);
  });

  it('normalizeAlerts is usable on its own', () => {
    expect(normalizeAlerts([alert()], [], () => undefined)).toEqual([
      expect.objectContaining({ tile: 'insight:BkT5Alrt', target: { kind: 'other' } }),
    ]);
  });
});

// ---------- observed ----------

function pageOf(names: (string | [string, unknown])[]): Raw[] {
  return names.map((n) =>
    typeof n === 'string'
      ? { name: n, is_seen_on_filtered_events: true }
      : { name: n[0], is_seen_on_filtered_events: n[1] },
  );
}

const observedInsights = (): Raw[] => [
  insight(
    trends(
      [
        ev('book_viewed', {
          math: 'avg',
          math_property: 'price',
          properties: [{ key: 'genre', type: 'event', value: 'Fiction' }],
        }),
        {
          kind: 'GroupNode',
          operator: 'OR',
          nodes: [
            ev('wishlist_added', { properties: [{ key: 'shelf', type: 'event', value: 'x' }] }),
            ev('wishlist_synced'),
          ],
          properties: [{ key: 'plan', type: 'person', value: 'pro' }],
        },
        { kind: 'ActionsNode', id: 5 },
        { kind: 'EventsNode', event: null, properties: [{ key: 'ignored', type: 'event' }] },
      ],
      {
        properties: {
          type: 'OR',
          values: [
            { key: 'channel', type: 'event', value: 'web' },
            { key: 'source', type: 'event', value: 'ad' },
          ],
        },
        breakdownFilter: {
          breakdowns: [
            { type: 'event', property: 'format' },
            { type: 'person', property: 'country' },
          ],
        },
      },
    ),
    { dashboards: [41] },
  ),
  insight({
    kind: 'FunnelsQuery',
    series: [ev('cart_viewed'), ev('order_completed')],
    funnelsFilter: {
      exclusions: [
        { kind: 'EventsNode', event: 'cart_cleared', funnelFromStep: 0, funnelToStep: 1 },
      ],
    },
  }),
];

const observedActions = actionLookup([
  {
    id: 5,
    steps: [
      {
        event: 'order_completed',
        properties: [{ key: 'total', type: 'event', operator: 'gt', value: 1 }],
      },
      { event: null, properties: [{ key: 'anywhere', type: 'event', value: 1 }] },
    ],
  },
]);

const observedDashboards = [
  {
    id: 41,
    name: 'Bookshop growth',
    filters: { properties: [{ key: 'region', type: 'event', value: 'EU' }] },
    tiles: [],
  },
];

function observedReq(): Requirements {
  return normalizeInsights(observedInsights(), {
    ...ctx,
    actions: observedActions,
    dashboards: observedDashboards,
  });
}

describe('references', () => {
  it('collects events, event properties per event and person properties', () => {
    const r = observedReq();
    expectValid(r);
    const refs = referencesOf(r);
    expect(refs.events).toEqual([
      'book_viewed',
      'cart_cleared',
      'cart_viewed',
      'order_completed',
      'wishlist_added',
      'wishlist_synced',
    ]);
    const shared = ['channel', 'format', 'region', 'source'];
    expect(Object.fromEntries(refs.eventProperties)).toEqual({
      book_viewed: [...shared, 'genre', 'price'].sort(),
      order_completed: [...shared, 'total'].sort(),
      wishlist_added: [...shared, 'shelf'].sort(),
      wishlist_synced: shared,
    });
    expect(refs.personProperties).toEqual(['country', 'plan']);
  });

  it('a tile with no event-scope property gives its events no entry', () => {
    const r = normalizeInsights([insight(trends([ev('a')]))], ctx);
    expect(referencesOf(r)).toEqual({
      events: ['a'],
      eventProperties: new Map(),
      personProperties: [],
    });
  });
});

describe('observed', () => {
  const eventDefinitions = [
    { name: 'book_viewed', last_seen_at: '2026-11-12T10:00:00.123456Z', enforcement_mode: 'allow' },
    {
      name: 'wishlist_added',
      last_seen_at: '2026-11-12T10:00:00+00:00',
      enforcement_mode: 'reject',
    },
    { name: 'wishlist_synced', last_seen_at: null, enforcement_mode: 'enforce' },
    { name: 'cart_viewed', last_seen_at: 'yesterday' },
    { name: 'cart_viewed', last_seen_at: '2020-01-01T00:00:00Z' },
    { name: 'order_completed', last_seen_at: 42 },
    { name: 'not_referenced', last_seen_at: '2026-11-12T10:00:00Z' },
    'junk',
    { last_seen_at: '2026-11-12T10:00:00Z' },
  ];

  it('records each referenced event: defined, last seen and enforcement', () => {
    const o = observedOf(observedReq(), { eventDefinitions });
    expect(o).toEqual({
      windowDays: 30,
      events: {
        book_viewed: {
          defined: true,
          lastSeenAt: '2026-11-12T10:00:00.123456Z',
          enforcement: 'allow',
        },
        cart_cleared: { defined: false },
        // The first definition of a name wins; a time that is not a time is left out.
        cart_viewed: { defined: true },
        order_completed: { defined: true },
        wishlist_added: {
          defined: true,
          lastSeenAt: '2026-11-12T10:00:00.000Z',
          enforcement: 'reject',
        },
        wishlist_synced: { defined: true, lastSeenAt: null },
      },
    });
  });

  it('records seen and not seen per event from definitions filtered by that event', () => {
    const eventProperties = new Map([
      ['book_viewed', pageOf(['genre', 'price', 'region', ['format', false], ['source', null]])],
      ['order_completed', pageOf([])],
      ['wishlist_added', pageOf(['shelf', 'channel', 'source', 'format', 'region'])],
      // wishlist_synced was not read: its properties stay unknown.
    ]);
    const o = observedOf(observedReq(), { eventDefinitions, eventProperties, windowDays: 7 });
    expect(o.windowDays).toBe(7);
    expect(o.eventProperties).toEqual({
      // A mark that is neither true nor false (source) says nothing.
      book_viewed: { seen: ['genre', 'price', 'region'], notSeen: ['channel', 'format'] },
      order_completed: { seen: [], notSeen: ['channel', 'format', 'region', 'source', 'total'] },
      wishlist_added: { seen: ['channel', 'format', 'region', 'shelf', 'source'], notSeen: [] },
    });
  });

  it('never calls "not seen" a property PostHog does not record per event', () => {
    const tiles = normalizeInsights(
      [
        insight(
          trends([
            ev('book_viewed', {
              properties: [
                { key: '$set', type: 'event', operator: 'is_set' },
                { key: '$groups', type: 'event', operator: 'is_set' },
                { key: '$feature/new-shelf', type: 'event', value: 'test' },
                { key: '$feature_enrollment/beta', type: 'event', value: true },
                { key: 'k'.repeat(201), type: 'event', value: 1 },
                { key: 'genre', type: 'event', value: 'x' },
              ],
            }),
            ev('$groupidentify', { properties: [{ key: 'genre', type: 'event', value: 'x' }] }),
            ev('$$plugin_metrics', { properties: [{ key: 'genre', type: 'event', value: 'x' }] }),
            ev('e'.repeat(201), { properties: [{ key: 'genre', type: 'event', value: 'x' }] }),
            ev('only_skipped', {
              properties: [{ key: '$set_once', type: 'event', operator: 'is_set' }],
            }),
          ]),
        ),
      ],
      ctx,
    );
    const empty = (): Raw[] => [];
    const eventProperties = new Map(
      ['book_viewed', '$groupidentify', '$$plugin_metrics', 'e'.repeat(201), 'only_skipped'].map(
        (e) => [e, empty()],
      ),
    );
    const o = observedOf(tiles, { eventDefinitions: [], eventProperties });
    expect(o.eventProperties).toEqual({ book_viewed: { seen: [], notSeen: ['genre'] } });
    // An event name too long for PostHog to define is not "not defined", it is unknown.
    expect(Object.keys(o.events).sort()).toEqual(
      ['$$plugin_metrics', '$groupidentify', 'book_viewed', 'only_skipped'].sort(),
    );
  });

  it('records referenced person properties PostHog knows by name; push subscription keys stay unknown', () => {
    const r = normalizeInsights(
      [
        insight(
          trends([ev('a')], {
            properties: [
              { key: 'plan', type: 'person', value: 'pro' },
              { key: 'country', type: 'person', value: 'IN' },
              { key: '$device_push_subscription_abc', type: 'person', operator: 'is_set' },
            ],
          }),
        ),
      ],
      ctx,
    );
    // With no event filter PostHog marks every person property unseen; the name is what counts.
    const personProperties = [
      { name: 'plan', is_seen_on_filtered_events: false },
      { name: 'email', is_seen_on_filtered_events: false },
    ];
    expect(observedOf(r, { eventDefinitions: [], personProperties }).personProperties).toEqual({
      seen: ['plan'],
      notSeen: ['country'],
    });
    expect(observedOf(r, { eventDefinitions: [] })).not.toHaveProperty('personProperties');
    expect(observedOf(r, { eventDefinitions: [] })).not.toHaveProperty('eventProperties');
  });

  it('writes an event named like an object key as its own entry', () => {
    const r = normalizeInsights([insight(trends([ev('__proto__'), ev('constructor')]))], ctx);
    const o = observedOf(r, { eventDefinitions: [{ name: '__proto__', last_seen_at: null }] });
    expect(Object.keys(o.events)).toEqual(['__proto__', 'constructor']);
    expect(o.events.constructor).toEqual({ defined: false });
    expectValid({ ...r, observed: o });
  });

  it('rejects a window that is not a whole number of days', () => {
    for (const windowDays of [0, -1, 1.5, Number.NaN])
      expect(() => observedOf(observedReq(), { eventDefinitions: [], windowDays })).toThrow(
        RangeError,
      );
  });

  it('withObserved writes requirements that validate and round trip', () => {
    const r = withObserved(observedReq(), {
      eventDefinitions,
      eventProperties: new Map([['book_viewed', pageOf(['genre'])]]),
      personProperties: [{ name: 'plan' }],
    });
    expectValid(r);
    expect(JSON.parse(toCanonicalJson(r))).toEqual(r);
  });
});

describe('observedEvent (6.5.4 window)', () => {
  const observed: Observed = {
    windowDays: 30,
    events: {
      fresh: { defined: true, lastSeenAt: '2026-12-17T22:41:00Z' },
      edge: { defined: true, lastSeenAt: '2026-11-18T09:12:00Z' },
      stale: { defined: true, lastSeenAt: '2026-11-18T09:11:59Z' },
      never: { defined: false },
      unset: { defined: true, lastSeenAt: null },
      noTime: { defined: true },
      bad: { defined: true, lastSeenAt: 'not a time' },
    },
  };
  const at = '2026-12-18T09:12:00Z';

  it.each([
    ['fresh', 'yes'],
    ['edge', 'yes'],
    ['stale', 'no'],
    ['never', 'no'],
    ['unset', 'unknown'],
    ['noTime', 'unknown'],
    ['bad', 'unknown'],
    ['not_read', 'unknown'],
    ['constructor', 'unknown'],
  ])('%s is %s', (event, want) => {
    expect(observedEvent(observed, event, at)).toBe(want);
    expect(observedEvent(observed, event, new Date(at))).toBe(want);
  });

  it('is unknown without observed data or a pull time', () => {
    expect(observedEvent(undefined, 'fresh', at)).toBe('unknown');
    expect(observedEvent(observed, 'fresh', 'whenever')).toBe('unknown');
  });
});

// ---------- recorded demo responses (contract) ----------

describe('recorded demo responses', () => {
  const rec = JSON.parse(
    readFileSync(new URL('../../../fixtures/posthog-recorded/demo.json', import.meta.url), 'utf8'),
  ) as {
    recorded: { host: string; project: number };
    responses: Record<string, { results?: Raw[] }>;
  };
  const entries = Object.entries(rec.responses);
  const results = (re: RegExp): Raw[] =>
    entries.filter(([p]) => re.test(p)).flatMap(([, b]) => b.results ?? []);
  const bodies = (re: RegExp): unknown[] => entries.filter(([p]) => re.test(p)).map(([, b]) => b);

  const r = normalizeInsights(results(/^insights\//), {
    host: rec.recorded.host,
    project: rec.recorded.project,
    dashboards: bodies(/^dashboards\/\d+\/$/),
    actions: actionLookup(bodies(/^actions\/\d+\/$/)),
    alerts: results(/^alerts\//),
  });
  const eventProperties = new Map(
    entries
      .filter(([p]) => p.startsWith('property_definitions/?type=event&'))
      .map(([p, b]) => {
        const names = JSON.parse(
          new URLSearchParams(p.slice(p.indexOf('?') + 1)).get('event_names') ?? '[]',
        ) as string[];
        return [names[0] ?? '', b.results ?? []] as const;
      }),
  );
  const full = withObserved(r, {
    eventDefinitions: results(/^event_definitions\//),
    eventProperties,
    personProperties: results(/^property_definitions\/\?type=person/),
  });

  it('expand every action and read every alert', () => {
    expectValid(full);
    for (const t of full.tiles)
      for (const n of t.notChecked ?? []) expect(n.reason).not.toMatch(/was not read/);
    expect(actionIdsOf(full).length).toBeGreaterThan(0);
    expect(full.alerts?.length).toBe(5);
    const tiles = new Set(full.tiles.map((t) => t.id));
    for (const a of full.alerts ?? []) expect(tiles.has(a.tile)).toBe(true);
  });

  it('give observed facts for every referenced event', () => {
    const refs = referencesOf(full);
    const defined = new Set(results(/^event_definitions\//).map((d) => d.name));
    expect(Object.keys(full.observed?.events ?? {})).toEqual(refs.events);
    for (const e of refs.events) expect(full.observed?.events[e]?.defined).toBe(defined.has(e));
    expect(Object.keys(full.observed?.eventProperties ?? {}).length).toBeGreaterThan(0);
  });
});
