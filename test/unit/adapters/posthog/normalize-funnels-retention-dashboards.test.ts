// The PostHog normalisers for funnels, retention and dashboards (spec 6.5.3, T5.3, ADR-033): funnel
// steps stay distinct by index, exclusions keep their step range, retention entities are read as
// PostHog's runner reads them, and dashboard filters land on the dashboard with every tile part the
// format cannot carry recorded as not checked.
import { describe, expect, it } from 'vitest';
import {
  normalizeInsight,
  normalizeInsights,
  type NormalizeContext,
} from '../../../../src/adapters/posthog/normalize/index.js';
import type { Requirements, Tile } from '../../../../src/formats/requirements.js';
import { validateRequirements } from '../../../../src/formats/validate.js';

type Raw = Record<string, unknown>;

const ctx: NormalizeContext = { host: 'https://us.posthog.com', project: 1001 };

function expectValid(r: Requirements): void {
  const v = validateRequirements(r);
  expect(v.ok ? [] : v.errors).toEqual([]);
}

function insight(source: unknown, extra: Raw = {}): Raw {
  return {
    id: 7,
    short_id: 'Zz000001',
    name: 'Test tile',
    query: { kind: 'InsightVizNode', source },
    dashboards: [],
    ...extra,
  };
}

function tile(raw: Raw, c: NormalizeContext = ctx): Tile {
  const t = normalizeInsight(raw, c);
  expectValid({ schema: 'dashlint.requirements/1', source: { platform: 'posthog' }, tiles: [t] });
  return t;
}

const ev = (event: string | null, extra: Raw = {}): Raw => ({
  kind: 'EventsNode',
  event,
  ...extra,
});
const prop = (key: string, value: unknown = key): Raw => ({
  key,
  type: 'event',
  operator: 'exact',
  value,
});

const funnel = (series: unknown, funnelsFilter: unknown = {}, extra: Raw = {}): Raw => ({
  kind: 'FunnelsQuery',
  series,
  funnelsFilter,
  version: 2,
  ...extra,
});

const retention = (retentionFilter: unknown, extra: Raw = {}): Raw => ({
  kind: 'RetentionQuery',
  retentionFilter,
  version: 2,
  ...extra,
});

describe('funnels', () => {
  it('the same event in two steps stays two distinct steps (negative control)', () => {
    const t = tile(
      insight(
        funnel([
          ev('basket_viewed'),
          ev('basket_viewed'),
          ev('basket_viewed', { properties: [prop('step', 'pay')] }),
        ]),
      ),
    );
    expect(t.series).toEqual([
      { ref: 'A', node: 'event', event: 'basket_viewed', filters: [] },
      { ref: 'B', node: 'event', event: 'basket_viewed', filters: [] },
      {
        ref: 'C',
        node: 'event',
        event: 'basket_viewed',
        filters: [{ key: 'step', scope: 'event', op: 'exact', values: ['pay'] }],
      },
    ]);
    expect(t.notChecked).toEqual([]);
  });

  it('reads group, warehouse and all-events steps; refuses the trends warehouse node', () => {
    const t = tile(
      insight(
        funnel([
          { kind: 'GroupNode', operator: 'OR', nodes: [ev('a'), ev('b')] },
          { kind: 'FunnelsDataWarehouseNode', table_name: 'orders' },
          ev(null),
          { kind: 'DataWarehouseNode', table_name: 'orders' },
        ]),
      ),
    );
    expect(t.series?.map((s) => s.node)).toEqual(['group', 'warehouse', 'all-events', 'warehouse']);
    expect(t.notChecked).toEqual([
      { path: 'series[3]', reason: 'series node kind DataWarehouseNode is not checked' },
    ]);
  });

  it('keeps exclusions with their step range, and records those it cannot place', () => {
    const lookup = (id: number | string) =>
      id === 3
        ? { id, name: 'Gave up', steps: [{ event: 'basket_emptied', filters: [] }] }
        : undefined;
    const t = tile(
      insight(
        funnel([ev('a'), ev('b'), ev('c')], {
          exclusions: [
            {
              ...ev('basket_emptied', { properties: [prop('reason')] }),
              funnelFromStep: 0,
              funnelToStep: 2,
            },
            { ...ev('x'), funnelFromStep: 1, funnelToStep: 1 },
            { ...ev('y'), funnelFromStep: 2 },
            { ...ev('z'), funnelFromStep: -1, funnelToStep: 1 },
            'nope',
            { ...ev(null), funnelFromStep: 1, funnelToStep: 2 },
            { kind: 'ActionsNode', id: 3, funnelFromStep: 0, funnelToStep: 1 },
            { kind: 'ActionsNode', id: 4, funnelFromStep: 0, funnelToStep: 1 },
            {
              kind: 'GroupNode',
              operator: 'OR',
              nodes: [ev('a')],
              funnelFromStep: 0,
              funnelToStep: 1,
            },
          ],
        }),
      ),
      { ...ctx, actions: lookup },
    );
    expect(t.exclusions).toEqual([
      {
        node: 'event',
        event: 'basket_emptied',
        fromStep: 0,
        toStep: 2,
        filters: [{ key: 'reason', scope: 'event', op: 'exact', values: ['reason'] }],
      },
      { node: 'all-events', fromStep: 1, toStep: 2, filters: [] },
      {
        node: 'action',
        action: { id: 3, name: 'Gave up', steps: [{ event: 'basket_emptied', filters: [] }] },
        fromStep: 0,
        toStep: 1,
        filters: [],
      },
      { node: 'action', action: { id: 4, steps: [] }, fromStep: 0, toStep: 1, filters: [] },
      { node: 'warehouse', fromStep: 0, toStep: 1 },
    ]);
    expect(t.notChecked).toEqual([
      { path: 'exclusions', reason: 'exclusion 1 with steps 1 to 1 is not checked' },
      { path: 'exclusions', reason: 'exclusion 2 with steps 2 to null is not checked' },
      { path: 'exclusions', reason: 'exclusion 3 with steps -1 to 1 is not checked' },
      { path: 'exclusions', reason: 'exclusion 4 with no steps is not checked' },
      { path: 'exclusions[3]', reason: 'action 4 was not read' },
      { path: 'exclusions[4]', reason: 'series node kind GroupNode is not checked' },
    ]);
  });

  it('exclusions that are not a list are not checked; none is an empty list', () => {
    expect(tile(insight(funnel([ev('a')], { exclusions: 'x' }))).notChecked).toEqual([
      { path: 'exclusions', reason: 'exclusions that are not a list are not checked' },
    ]);
    for (const funnelsFilter of [{}, { exclusions: null }, null, 'x'])
      expect(tile(insight(funnel([ev('a')], funnelsFilter))).exclusions).toEqual([]);
  });

  it('keeps the viz type, PostHog default steps, and leaves out one that is not a name', () => {
    const viz = (funnelsFilter: unknown): unknown =>
      tile(insight(funnel([ev('a')], funnelsFilter))).funnelVizType;
    expect(viz({ funnelVizType: 'time_to_convert' })).toBe('time_to_convert');
    expect(viz({ funnelVizType: 'trends' })).toBe('trends');
    expect(viz({})).toBe('steps');
    expect(viz({ funnelVizType: null })).toBe('steps');
    expect(viz(null)).toBe('steps');
    expect(viz({ funnelVizType: 5 })).toBeUndefined();
    expect(viz({ funnelVizType: 'Not A Name' })).toBeUndefined();
  });

  it('reads insight filters and breakdowns; an unknown version reads nothing', () => {
    const t = tile(
      insight(
        funnel(
          [ev('a')],
          {},
          {
            properties: [prop('format', 'ebook')],
            breakdownFilter: { breakdown: 'genre', breakdown_type: 'event' },
          },
        ),
      ),
    );
    expect(t.filters).toEqual([{ key: 'format', scope: 'event', op: 'exact', values: ['ebook'] }]);
    expect(t.breakdown).toEqual([{ key: 'genre', scope: 'event' }]);
    const u = tile(insight(funnel([ev('a')], { funnelVizType: 'trends' }, { version: 3 })));
    expect(u).toMatchObject({
      kind: 'funnels',
      series: [],
      exclusions: [],
      notChecked: [{ reason: 'query kind FunnelsQuery version 3 is not checked' }],
    });
    expect(u.funnelVizType).toBeUndefined();
  });
});

describe('retention', () => {
  const entities = (target: unknown, returning: unknown, lookup?: NormalizeContext['actions']) =>
    tile(
      insight(retention({ targetEntity: target, returningEntity: returning })),
      lookup ? { ...ctx, actions: lookup } : ctx,
    );

  it("a missing entity is PostHog's $pageview; no id is all events; properties are filters", () => {
    const t = entities(undefined, { id: null, type: 'events', properties: [prop('plan', 'pro')] });
    expect(t.retention).toEqual({
      target: { node: 'event', event: '$pageview', filters: [] },
      returning: {
        node: 'all-events',
        filters: [{ key: 'plan', scope: 'event', op: 'exact', values: ['pro'] }],
      },
    });
    expect(entities(null, { id: 'book_viewed' }).retention?.returning).toEqual({
      node: 'event',
      event: 'book_viewed',
      filters: [],
    });
    expect(entities({ id: 'a', kind: 'EventsNode' }, {}).retention?.returning).toEqual({
      node: 'all-events',
      filters: [],
    });
  });

  it('reads actions by type or kind, through the lookup or as not read', () => {
    const lookup = (id: number | string) =>
      String(id) === '3' ? { id, steps: [{ event: 'order_completed', filters: [] }] } : undefined;
    const t = entities(
      { id: 3, type: 'actions', name: 'Bought' },
      { id: 9, kind: 'ActionsNode' },
      lookup,
    );
    expect(t.retention).toEqual({
      target: {
        node: 'action',
        action: { id: 3, steps: [{ event: 'order_completed', filters: [] }] },
        filters: [],
      },
      returning: { node: 'action', action: { id: 9, steps: [] }, filters: [] },
    });
    expect(t.notChecked).toEqual([
      { path: 'retention.returning', reason: 'action 9 was not read' },
    ]);
  });

  it('entities it cannot represent are never-checked nodes with the reason', () => {
    const t = tile(
      insight(
        retention({
          targetEntity: { type: 'data_warehouse', table_name: 'orders' },
          returningEntity: { id: 5, type: 'events' },
        }),
      ),
    );
    expect(t.retention).toEqual({
      target: { node: 'warehouse', table: 'orders' },
      returning: { node: 'warehouse' },
    });
    expect(t.notChecked).toEqual([
      { path: 'retention.returning', reason: 'a retention event entity with id 5 is not checked' },
    ]);
    const cases: [unknown, string][] = [
      [{ id: 'a', type: 'new_entity' }, 'a retention entity of type "new_entity" is not checked'],
      [{ id: 'a', type: 'groups' }, 'a retention entity of type "groups" is not checked'],
      [{ id: 'a', kind: 'PersonsNode' }, 'a retention entity of kind "PersonsNode" is not checked'],
      ['x', 'a retention entity that is not an object is not checked'],
      [{ id: '' }, 'an event node with event "" is not checked'],
      [{ type: 'actions' }, 'an action node with no id is not checked'],
    ];
    for (const [entity, reason] of cases) {
      const u = entities(entity, null);
      expect(u.retention?.target).toEqual({ node: 'warehouse' });
      expect(u.notChecked).toEqual([{ path: 'retention.target', reason }]);
    }
  });

  it('reads filters and breakdowns; names a property aggregation; an unknown version reads nothing', () => {
    const t = tile(
      insight(
        retention(
          {
            targetEntity: { id: 'a' },
            aggregationType: 'sum',
            aggregationProperty: 'price',
            aggregationPropertyType: 'person',
          },
          {
            properties: { type: 'AND', values: [prop('format', 'ebook')] },
            breakdownFilter: { breakdowns: [{ property: 'genre', type: 'person' }] },
          },
        ),
      ),
    );
    expect(t.filters).toEqual([{ key: 'format', scope: 'event', op: 'exact', values: ['ebook'] }]);
    expect(t.breakdown).toEqual([{ key: 'genre', scope: 'person' }]);
    expect(t.notChecked).toEqual([
      { path: 'retention', reason: 'a retention sum of person property price is not checked' },
    ]);
    for (const quiet of [
      { aggregationType: 'count', aggregationProperty: 'price' },
      { aggregationType: 'avg', aggregationProperty: '' },
    ])
      expect(tile(insight(retention(quiet))).notChecked).toEqual([]);
    expect(
      tile(insight(retention({ aggregationType: 'avg', aggregationProperty: 'p' }))).notChecked,
    ).toEqual([
      { path: 'retention', reason: 'a retention avg of event property p is not checked' },
    ]);
    const u = tile(insight(retention({ targetEntity: { id: 'a' } }, { version: 3 })));
    expect(u.retention).toEqual({
      target: { node: 'warehouse' },
      returning: { node: 'warehouse' },
    });
    expect(u.notChecked).toEqual([
      { reason: 'query kind RetentionQuery version 3 is not checked' },
    ]);
  });
});

describe('paths, SQL and other kinds', () => {
  it('are not checked with the kind named', () => {
    const t = (query: unknown): Tile => tile({ ...insight(null), query });
    expect(t({ kind: 'InsightVizNode', source: { kind: 'PathsQuery', version: 1 } })).toMatchObject(
      {
        kind: 'paths',
        notChecked: [{ reason: 'query kind PathsQuery is not checked' }],
      },
    );
    expect(
      t({ kind: 'DataVisualizationNode', source: { kind: 'HogQLQuery', query: 'select 1' } }),
    ).toMatchObject({
      kind: 'sql',
      notChecked: [{ reason: 'query kind HogQLQuery is not checked' }],
    });
    expect(t(null)).toMatchObject({
      kind: 'other',
      notChecked: [{ reason: 'insight has no query' }],
    });
  });
});

// ---------- dashboards ----------

const trendsInsight = (shortId: string, id: number, extra: Raw = {}, source: Raw = {}): Raw =>
  insight(
    { kind: 'TrendsQuery', series: [ev('book_viewed')], version: 4, ...source },
    { id, short_id: shortId, ...extra },
  );

function board(id: unknown, tiles: unknown[], filters: unknown = {}, extra: Raw = {}): Raw {
  return { id, name: `Board ${String(id)}`, filters, tiles, ...extra };
}

const on = (shortId: string, filters_overrides: unknown = {}, extra: Raw = {}): Raw => ({
  insight: { id: 0, short_id: shortId },
  filters_overrides,
  ...extra,
});

function pull(insights: Raw[], dashboards: unknown[]): Requirements {
  const r = normalizeInsights(insights, { ...ctx, dashboards });
  expectValid(r);
  return r;
}

const notes = (r: Requirements, id: string) => r.tiles.find((t) => t.id === id)?.notChecked;

describe('dashboards', () => {
  it('keeps names and filters, adds the dashboard to its tiles, and leaves deleted ones out', () => {
    const r = pull(
      [
        trendsInsight('T1', 1, { dashboards: [9, 12] }),
        trendsInsight('T2', 2),
        trendsInsight('T3', 3),
      ],
      [
        board(
          10,
          [on('T1'), { insight: 2, filters_overrides: null }, on('T3', {}, { deleted: true })],
          {
            properties: [prop('format', 'ebook')],
            date_from: '-7d',
            interval: 'week',
          },
        ),
        board(9, [on('T1')], null, { name: '' }),
        board(12, [on('T1')], {}, { deleted: true }),
        board(10, [on('T3')]),
        board('', [on('T3')]),
        board(11, [on('Gone'), 'x', on('T2', { date_from: '-1d', filterTestAccounts: false })]),
        'not a dashboard',
      ],
    );
    expect(r.dashboards).toEqual([
      {
        id: 'dashboard:10',
        name: 'Board 10',
        filters: [{ key: 'format', scope: 'event', op: 'exact', values: ['ebook'] }],
      },
      { id: 'dashboard:11', name: 'Board 11', filters: [] },
      { id: 'dashboard:9', filters: [] },
    ]);
    expect(r.tiles.map((t) => [t.id, t.dashboards])).toEqual([
      ['insight:T1', ['dashboard:10', 'dashboard:9']],
      ['insight:T2', ['dashboard:10', 'dashboard:11']],
      ['insight:T3', []],
    ]);
    for (const t of r.tiles) expect(t.notChecked).toEqual([]);
  });

  it('without dashboard bodies, tiles keep the dashboards their insight lists', () => {
    const r = normalizeInsights([trendsInsight('T1', 1, { dashboards: [3, 2, 3] })], ctx);
    expect(r.dashboards).toEqual([]);
    expect(r.tiles[0]?.dashboards).toEqual(['dashboard:2', 'dashboard:3']);
  });

  it('records dashboard filters it cannot read on every tile of the dashboard', () => {
    const r = pull(
      [trendsInsight('T1', 1), trendsInsight('T2', 2, { dashboards: [5] })],
      [
        board(5, [on('T1')], {
          properties: [{ type: 'event', operator: 'exact' }, prop('format')],
        }),
        board(6, [on('T1')], 'nope'),
      ],
    );
    expect(r.dashboards?.map((d) => d.filters)).toEqual([
      [{ key: 'format', scope: 'event', op: 'exact', values: ['format'] }],
      [],
    ]);
    const unreadable = {
      path: 'filters',
      reason: 'dashboard:5: a property filter of type event with no key is not checked',
    };
    expect(notes(r, 'insight:T2')).toEqual([unreadable]);
    expect(notes(r, 'insight:T1')).toEqual([
      unreadable,
      {
        path: 'filters',
        reason: 'dashboard:6: dashboard filters that are not an object are not checked',
      },
    ]);
  });

  it('a dashboard breakdown is not checked unless the tile overrides it', () => {
    const r = pull(
      [trendsInsight('T1', 1), trendsInsight('T2', 2)],
      [
        board(5, [on('T1'), on('T2', { breakdown_filter: { breakdown: 'genre' } })], {
          breakdown_filter: { breakdowns: [{ property: 'format', type: 'event' }] },
        }),
      ],
    );
    expect(notes(r, 'insight:T1')).toEqual([
      {
        path: 'breakdown',
        reason: 'dashboard:5 breaks every tile down by format (event), which is not checked',
      },
    ]);
    expect(notes(r, 'insight:T2')).toEqual([
      {
        path: 'breakdown',
        reason: 'dashboard:5 breaks this tile down by genre (event), which is not checked',
      },
    ]);
  });

  it('tile overrides: added filters, ignored dashboard filters, unreadable overrides', () => {
    const r = pull(
      [
        trendsInsight('T1', 1),
        trendsInsight('T2', 2),
        trendsInsight('T3', 3),
        trendsInsight('T4', 4),
      ],
      [
        board(
          5,
          [
            on('T1', { properties: [prop('plan'), prop('plan', 'b'), prop('region')] }),
            on('T2', { ignoreDashboardFilters: true }),
            on('T3', { properties: [{ type: 'event' }] }),
            on('T4', { ignoreDashboardFilters: false, properties: [] }),
          ],
          { properties: [prop('format')] },
        ),
        board(6, [on('T2', { ignoreDashboardFilters: true })]),
      ],
    );
    expect(notes(r, 'insight:T1')).toEqual([
      {
        path: 'filters',
        reason: 'dashboard:5 adds filters to this tile only (plan, region), which is not checked',
      },
    ]);
    expect(notes(r, 'insight:T2')).toEqual([
      {
        path: 'filters',
        reason: 'dashboard:5 filters are ignored by this tile, which is not checked',
      },
    ]);
    expect(notes(r, 'insight:T3')).toEqual([
      {
        path: 'filters',
        reason: 'dashboard:5 adds filters to this tile only, which is not checked',
      },
    ]);
    expect(notes(r, 'insight:T4')).toEqual([]);
  });

  it('a dashboard filter on a key the tile filters too, or on a tile with a warehouse series', () => {
    const r = pull(
      [
        trendsInsight('T1', 1, {}, { properties: [prop('format', 'audio')] }),
        trendsInsight(
          'T2',
          2,
          {},
          {
            series: [
              ev('a', { properties: { type: 'OR', values: [prop('genre'), prop('lang')] } }),
            ],
          },
        ),
        trendsInsight(
          'T3',
          3,
          {},
          { series: [{ kind: 'DataWarehouseNode', table_name: 'orders' }] },
        ),
        trendsInsight('T4', 4, {}, { properties: [prop('other')] }),
      ],
      [
        board(5, [on('T1'), on('T2'), on('T3'), on('T4')], {
          properties: { type: 'OR', values: [prop('format'), prop('lang')] },
        }),
      ],
    );
    const overlap = (key: string) => ({
      path: 'filters',
      reason: `dashboard:5 filters ${key} as the tile does; PostHog may drop the tile's filter, which is not checked`,
    });
    expect(notes(r, 'insight:T1')).toEqual([overlap('format')]);
    expect(notes(r, 'insight:T2')).toEqual([overlap('lang')]);
    expect(notes(r, 'insight:T3')).toEqual([
      {
        path: 'filters',
        reason:
          'dashboard:5 filters skip a tile with a data warehouse series, which is not checked',
      },
    ]);
    expect(notes(r, 'insight:T4')).toEqual([]);
  });

  it('finds tiles by short id or numeric id, and never by a deleted insight', () => {
    const r = pull(
      [trendsInsight('T1', 1), trendsInsight('T2', 2), trendsInsight('T3', 3, { deleted: true })],
      [board(5, [{ insight: { id: 2 } }, { insight: 1 }, on('T3'), { insight: null }, {}])],
    );
    expect(r.tiles.map((t) => [t.id, t.dashboards])).toEqual([
      ['insight:T1', ['dashboard:5']],
      ['insight:T2', ['dashboard:5']],
    ]);
  });
});
