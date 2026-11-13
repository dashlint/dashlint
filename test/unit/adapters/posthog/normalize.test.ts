// The PostHog normalisers (spec 6.5.3, T5.2): each synthetic twin (T2.4, ADR-019) normalises to its
// expected requirements byte for byte, every output validates, and shapes dashlint cannot read
// become "not checked" parts with the reason, never an exception.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dropOnArrival } from '../../../../src/adapters/posthog/client.js';
import {
  LATEST_QUERY_VERSIONS,
  normalizeInsight,
  normalizeInsights,
  type NormalizeContext,
} from '../../../../src/adapters/posthog/normalize/index.js';
import { refOf } from '../../../../src/adapters/posthog/normalize/common.js';
import { toCanonicalJson } from '../../../../src/formats/canonical.js';
import type { Requirements, Tile } from '../../../../src/formats/requirements.js';
import { validateRequirements } from '../../../../src/formats/validate.js';

type Raw = Record<string, unknown>;

const dir = new URL('../../../fixtures/posthog/', import.meta.url);
const ctx: NormalizeContext = { host: 'https://us.posthog.com', project: 1001 };

function responsesOf(shape: string): Record<string, unknown> {
  return (
    JSON.parse(readFileSync(new URL(`${shape}.json`, dir), 'utf8')) as {
      responses: Record<string, unknown>;
    }
  ).responses;
}

function insightsOf(shape: string): Raw[] {
  const page = responsesOf(shape)['insights/?saved=true'] as { results: Raw[] } | undefined;
  return dropOnArrival(page?.results ?? []) as Raw[];
}

/** The twin's context: its dashboard bodies (`dashboards/<id>/`), as `pull` reads them. */
function ctxOf(shape: string): NormalizeContext {
  const dashboards = Object.entries(responsesOf(shape))
    .filter(([path]) => /^dashboards\/[^/]+\/$/.test(path))
    .map(([, body]) => body);
  return { ...ctx, dashboards };
}

function expectedOf(shape: string): Requirements {
  return JSON.parse(readFileSync(new URL(`expected/${shape}.json`, dir), 'utf8')) as Requirements;
}

function expectValid(r: Requirements): void {
  const v = validateRequirements(r);
  expect(v.ok ? [] : v.errors).toEqual([]);
}

const TWINS = [
  'trends-events',
  'trends-all-events',
  'trends-group-or',
  'trends-math',
  'trends-builtin-events',
  'trends-formulas',
  'trends-breakdowns',
  'trends-property-filters',
  'trends-options',
  'lifecycle-stickiness',
  'funnel-repeated-steps',
  'retention',
  'not-checked-kinds',
  'dashboards',
];

describe('twins (T2.4) normalise byte for byte', () => {
  it.each(TWINS)('%s', (shape) => {
    const out = normalizeInsights(insightsOf(shape), ctxOf(shape));
    expectValid(out);
    expect(toCanonicalJson(out)).toBe(readFileSync(new URL(`expected/${shape}.json`, dir), 'utf8'));
  });

  // Twins that also need actions or alerts (T5.4): their tiles are exact up to the expansion of
  // action nodes (only the action id is compared, and "was not read" entries are dropped).
  const others = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((s) => !TWINS.includes(s));
  const withoutActions = (t: Tile): string =>
    JSON.stringify(
      {
        ...t,
        notChecked: (t.notChecked ?? []).filter((n) => !/^action .* was not read$/.test(n.reason)),
      },
      (key, v: unknown) =>
        key === 'action' && typeof v === 'object' && v !== null ? { id: (v as Raw).id } : v,
    );
  it.each(others)('%s: tiles up to action expansion', (shape) => {
    const expected = expectedOf(shape).tiles;
    const got = normalizeInsights(insightsOf(shape), ctxOf(shape)).tiles;
    expect(toCanonicalJson(got.map((t) => JSON.parse(withoutActions(t)) as unknown))).toBe(
      toCanonicalJson(expected.map((t) => JSON.parse(withoutActions(t)) as unknown)),
    );
  });

  it('cover every twin but the two T5.4 completes', () => {
    expect(others).toEqual(['alerts', 'funnel-action-steps']);
  });
});

// ---------- single insights ----------

function insight(source: unknown, extra: Raw = {}): Raw {
  return {
    id: 7,
    short_id: 'Zz000001',
    name: 'Test tile',
    query: source === undefined ? null : { kind: 'InsightVizNode', source },
    dashboards: [],
    ...extra,
  };
}

function trends(series: unknown, extra: Raw = {}): Raw {
  return { kind: 'TrendsQuery', series, version: 4, ...extra };
}

const ev = (event: string | null, extra: Raw = {}): Raw => ({
  kind: 'EventsNode',
  event,
  ...extra,
});

/** Normalises one insight and checks the result validates as a one-tile requirements file. */
function tile(raw: Raw, c: NormalizeContext = ctx): Tile {
  const t = normalizeInsight(raw, c);
  expectValid({ schema: 'dashlint.requirements/1', source: { platform: 'posthog' }, tiles: [t] });
  return t;
}

describe('query versions', () => {
  it('reads every version from 1 (or none) to the latest PostHog version', () => {
    for (const [kind, latest] of [
      ['TrendsQuery', 4],
      ['LifecycleQuery', 2],
      ['StickinessQuery', 4],
    ] as const) {
      expect(LATEST_QUERY_VERSIONS[kind]).toBe(latest);
      for (const version of [undefined, null, 1, latest]) {
        const t = tile(insight({ kind, series: [ev('book_viewed')], version }));
        expect(t.notChecked).toEqual([]);
        expect(t.series).toEqual([{ ref: 'A', node: 'event', event: 'book_viewed', filters: [] }]);
      }
    }
  });

  it.each([5, 0, '4', 2.5, -1])(
    'an unknown TrendsQuery version %j is not checked, naming the kind and version',
    (version) => {
      const t = tile(insight(trends([ev('book_viewed')], { version })));
      expect(t.kind).toBe('trends');
      expect(t.notChecked).toEqual([
        { reason: `query kind TrendsQuery version ${JSON.stringify(version)} is not checked` },
      ]);
      expect(t.series).toEqual([]);
      expect(t.formulas).toEqual([]);
      expect(t).not.toHaveProperty('dateRange');
    },
  );

  it('an unknown lifecycle or stickiness version is not checked', () => {
    expect(tile(insight({ kind: 'LifecycleQuery', series: [], version: 3 })).notChecked).toEqual([
      { reason: 'query kind LifecycleQuery version 3 is not checked' },
    ]);
    expect(tile(insight({ kind: 'StickinessQuery', series: [], version: 9 })).notChecked).toEqual([
      { reason: 'query kind StickinessQuery version 9 is not checked' },
    ]);
  });

  it('kinds that are not read are not checked with the kind named', () => {
    const t = tile(insight({ kind: 'WebOverviewQuery', dateRange: { date_from: '-7d' } }));
    expect(t.kind).toBe('other');
    expect(t.notChecked).toEqual([{ reason: 'query kind WebOverviewQuery is not checked' }]);
    expect(t.dateRange).toEqual({ from: '-7d', to: null });
    expect(tile(insight({ series: [] })).notChecked).toEqual([
      { reason: 'query kind InsightVizNode has no source kind and is not checked' },
    ]);
    expect(
      tile({ ...insight(undefined), query: { kind: 'InsightVizNode', source: 'x' } }).kind,
    ).toBe('other');
    expect(tile(insight(undefined)).notChecked).toEqual([{ reason: 'insight has no query' }]);
  });

  it('reads a bare query that is not wrapped in an InsightVizNode', () => {
    const t = tile({ ...insight(undefined), query: trends([ev('book_viewed')]) });
    expect(t.kind).toBe('trends');
    expect(t.notChecked).toEqual([]);
  });

  it('a query that throws while read is not checked, never an exception', () => {
    const source = trends([]);
    Object.defineProperty(source, 'series', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const t = tile(insight(source));
    expect(t.notChecked).toEqual([{ reason: 'query kind TrendsQuery could not be read (boom)' }]);
    expect(t.series).toEqual([]);
  });
});

describe('tile header', () => {
  it('falls back to the numeric id and the derived name; sorts and dedupes dashboards', () => {
    const t = tile(
      insight(trends([ev('a')]), {
        short_id: null,
        name: '',
        derived_name: 'A count',
        dashboards: [302, 301, 302, null],
      }),
    );
    expect(t.id).toBe('insight:7');
    expect(t.title).toBe('A count');
    expect(t.url).toBe('https://us.posthog.com/project/1001/insights/7');
    expect(t.dashboards).toEqual(['dashboard:301', 'dashboard:302']);
    expect(tile(insight(trends([]), { name: null, dashboards: 'x' }))).toMatchObject({
      title: '',
      dashboards: [],
    });
  });

  it('keeps date_to, and testAccountFilter only when true', () => {
    const t = tile(
      insight(
        trends([], {
          dateRange: { date_from: '2026-01-01', date_to: '2026-02-01' },
          filterTestAccounts: 'yes',
        }),
      ),
    );
    expect(t.dateRange).toEqual({ from: '2026-01-01', to: '2026-02-01' });
    expect(t.testAccountFilter).toBe(false);
    expect(tile(insight(trends([], { dateRange: {} }))).dateRange).toEqual({
      from: null,
      to: null,
    });
    expect(tile(insight(trends([]))).dateRange).toBeUndefined();
  });

  it('leaves deleted insights and non-objects out, and sorts tiles by id', () => {
    const r = normalizeInsights(
      [
        insight(trends([]), { short_id: 'b' }),
        insight(trends([]), { short_id: 'a' }),
        insight(trends([]), { short_id: 'c', deleted: true }),
        null,
        'x',
      ],
      ctx,
    );
    expect(r.tiles.map((t) => t.id)).toEqual(['insight:a', 'insight:b']);
    expectValid(r);
  });
});

describe('series nodes', () => {
  it('event, all-events (null or absent), with math and math property scopes', () => {
    const t = tile(
      insight(
        trends([
          ev('a', { math: 'DAU' }),
          { kind: 'EventsNode', math: 'total' },
          ev('b', { math: 'sum', math_property: 'price' }),
          ev('b', { math: 'avg', math_property: 'age', math_property_type: 'person_properties' }),
          ev('b', { math: 'max', math_property: 'n', math_property_type: 'groups_0' }),
          ev('b', {
            math: 'max',
            math_property: 'n',
            math_property_type: 'data_warehouse_properties',
          }),
          ev('b', { math: 'max', math_property: 'n', math_property_type: 7 }),
        ]),
      ),
    );
    expect(t.series).toEqual([
      { ref: 'A', node: 'event', event: 'a', math: 'dau', filters: [] },
      { ref: 'B', node: 'all-events', math: 'total', filters: [] },
      {
        ref: 'C',
        node: 'event',
        event: 'b',
        math: 'sum',
        mathProperty: { key: 'price', scope: 'event' },
        filters: [],
      },
      {
        ref: 'D',
        node: 'event',
        event: 'b',
        math: 'avg',
        mathProperty: { key: 'age', scope: 'person' },
        filters: [],
      },
      {
        ref: 'E',
        node: 'event',
        event: 'b',
        math: 'max',
        mathProperty: { key: 'n', scope: 'group' },
        filters: [],
      },
      {
        ref: 'F',
        node: 'event',
        event: 'b',
        math: 'max',
        mathProperty: { key: 'n', scope: 'other' },
        filters: [],
      },
      {
        ref: 'G',
        node: 'event',
        event: 'b',
        math: 'max',
        mathProperty: { key: 'n', scope: 'other' },
        filters: [],
      },
    ]);
    expect(t.notChecked).toEqual([]);
  });

  it('a math that is not a name, and HogQL math, are not checked parts', () => {
    const t = tile(
      insight(
        trends([ev('a', { math: 'per cent' }), ev('b', { math: 'hogql', math_hogql: 'sum(x)' })]),
      ),
    );
    expect(t.series?.[0]).toEqual({ ref: 'A', node: 'event', event: 'a', filters: [] });
    expect(t.series?.[1]).toMatchObject({ math: 'hogql' });
    expect(t.notChecked).toEqual([
      { path: 'series[0].math', reason: 'math "per cent" is not checked' },
      { path: 'series[1].math', reason: 'a HogQL math expression is not checked' },
    ]);
  });

  it('stamps kind-less series as PostHog migration 0004 does', () => {
    const t = tile(
      insight(
        trends(
          [
            { event: 'a' },
            {},
            { id: 3 },
            { nodes: [{ event: 'b' }], operator: 'OR' },
            { table_name: 'orders', math: 'total' },
          ],
          { version: 2 },
        ),
      ),
    );
    expect(t.series).toEqual([
      { ref: 'A', node: 'event', event: 'a', filters: [] },
      { ref: 'B', node: 'all-events', filters: [] },
      { ref: 'C', node: 'action', action: { id: 3, steps: [] }, filters: [] },
      {
        ref: 'D',
        node: 'group',
        operator: 'OR',
        events: [{ event: 'b', filters: [] }],
        filters: [],
      },
      { ref: 'E', node: 'warehouse', table: 'orders', math: 'total' },
    ]);
    expect(t.notChecked).toEqual([{ path: 'series[2]', reason: 'action 3 was not read' }]);
  });

  it('expands an action through the lookup, and names an action that was not read', () => {
    const lookup = (id: number | string) =>
      id === 9
        ? { id: 9, name: 'Purchased', steps: [{ event: 'order_completed', filters: [] }] }
        : undefined;
    const t = tile(
      insight(
        trends([
          { kind: 'ActionsNode', id: 9, math: 'total' },
          { kind: 'ActionsNode', id: 4, name: 'Signed up' },
          { kind: 'ActionsNode' },
        ]),
      ),
      { ...ctx, actions: lookup },
    );
    expect(t.series).toEqual([
      {
        ref: 'A',
        node: 'action',
        action: { id: 9, name: 'Purchased', steps: [{ event: 'order_completed', filters: [] }] },
        math: 'total',
        filters: [],
      },
      { ref: 'B', node: 'action', action: { id: 4, name: 'Signed up', steps: [] }, filters: [] },
      { ref: 'C', node: 'warehouse' },
    ]);
    expect(t.notChecked).toEqual([
      { path: 'series[1]', reason: 'action 4 was not read' },
      { path: 'series[2]', reason: 'an action node with no id is not checked' },
    ]);
  });

  it('series it cannot represent keep their ref as never-checked nodes', () => {
    const t = tile(
      insight(
        trends([
          null,
          { kind: 'FutureNode', event: 'a' },
          ev(''),
          { kind: 'GroupNode', operator: 'XOR', nodes: [ev('a')] },
          { kind: 'GroupNode', operator: 'OR', nodes: [{ kind: 'ActionsNode', id: 1 }, ev(null)] },
          ev('kept'),
        ]),
      ),
    );
    expect(t.series?.map((s) => [s.ref, s.node])).toEqual([
      ['A', 'warehouse'],
      ['B', 'warehouse'],
      ['C', 'warehouse'],
      ['D', 'warehouse'],
      ['E', 'warehouse'],
      ['F', 'event'],
    ]);
    expect(t.notChecked).toEqual([
      { path: 'series[0]', reason: 'a series item that is not an object is not checked' },
      { path: 'series[1]', reason: 'series node kind FutureNode is not checked' },
      { path: 'series[2]', reason: 'an event node with event "" is not checked' },
      { path: 'series[3]', reason: 'a group node with operator "XOR" is not checked' },
      { path: 'series[4]', reason: 'group member 0 (ActionsNode) is not checked' },
      { path: 'series[4]', reason: 'group member 1 (all events) is not checked' },
      { path: 'series[4]', reason: 'a group node with no event member is not checked' },
    ]);
  });

  it('a group keeps its event members, filters on members and on the group, and AND groups', () => {
    const t = tile(
      insight(
        trends([
          {
            kind: 'GroupNode',
            operator: 'AND',
            math: 'dau',
            properties: [{ key: 'genre', type: 'event', operator: 'exact', value: 'poetry' }],
            nodes: [ev('a', { properties: [{ key: 'format', value: 'ebook' }] }), 'x', ev('b')],
          },
        ]),
      ),
    );
    expect(t.series).toEqual([
      {
        ref: 'A',
        node: 'group',
        operator: 'AND',
        events: [
          {
            event: 'a',
            filters: [{ key: 'format', scope: 'event', op: 'exact', values: ['ebook'] }],
          },
          { event: 'b', filters: [] },
        ],
        math: 'dau',
        filters: [{ key: 'genre', scope: 'event', op: 'exact', values: ['poetry'] }],
      },
    ]);
    expect(t.notChecked).toEqual([
      { path: 'series[0]', reason: 'group member 1 (not an object) is not checked' },
    ]);
  });

  it('lifecycle takes its own warehouse node and refuses a group; stickiness refuses the lifecycle one', () => {
    const wh = { kind: 'LifecycleDataWarehouseNode', table_name: 'orders' };
    const l = tile(
      insight({
        kind: 'LifecycleQuery',
        series: [wh, { kind: 'GroupNode', operator: 'OR', nodes: [ev('a')] }],
      }),
    );
    expect(l.series).toEqual([
      { ref: 'A', node: 'warehouse', table: 'orders' },
      { ref: 'B', node: 'warehouse' },
    ]);
    expect(l.notChecked).toEqual([
      { path: 'series[1]', reason: 'series node kind GroupNode is not checked' },
    ]);
    const s = tile(insight({ kind: 'StickinessQuery', series: [wh] }));
    expect(s.notChecked).toEqual([
      { path: 'series[0]', reason: 'series node kind LifecycleDataWarehouseNode is not checked' },
    ]);
  });

  it('series that are not a list, or too many, are not checked', () => {
    expect(tile(insight(trends('A'))).notChecked).toEqual([
      { path: 'series', reason: 'series that are not a list are not checked' },
    ]);
    const many = tile(insight(trends(Array.from({ length: 703 }, () => ev('a')))));
    expect(many.series).toEqual([]);
    expect(many.notChecked).toEqual([{ reason: '703 series are more than 702' }]);
    const most = tile(insight(trends(Array.from({ length: 702 }, () => ev('a')))));
    expect(most.series?.at(-1)?.ref).toBe('ZZ');
  });

  it('series letters run A to Z, then AA to ZZ', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701].map(refOf)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
    ]);
  });
});

describe('property filters', () => {
  const one = (filters: unknown, extra: Raw = {}): Tile =>
    tile(insight(trends([ev('a', { properties: filters, ...extra })])));

  it('wraps scalars, keeps JSON types, defaults the operator and maps scopes', () => {
    const t = one([
      { key: 'genre', type: 'event', operator: 'exact', value: ['fiction', 'poetry'] },
      { key: 'n', value: 0 },
      { key: 'flag', type: 'event', operator: 'exact', value: true },
      { key: 'plan', type: 'person', operator: 'is_set' },
      { key: '$session_duration', type: 'session', operator: 'GT', value: 30 },
      { key: 'id', type: 'cohort', value: 5 },
      { key: 'name', type: 'group', group_type_index: 0, operator: 'icontains', value: 'shop' },
      { key: 'properties.x = 1', type: 'hogql' },
      { key: 'tag_name', type: 'element', operator: 'exact', value: ['a'] },
      { key: 'beta', type: 'flag', operator: 'flag_evaluates_to', value: true },
      {
        key: 'performed_event',
        type: 'behavioral',
        value: 'performed_event',
        event_type: 'events',
      },
    ]);
    expect(t.series?.[0]).toMatchObject({
      filters: [
        { key: 'genre', scope: 'event', op: 'exact', values: ['fiction', 'poetry'] },
        { key: 'n', scope: 'event', op: 'exact', values: [0] },
        { key: 'flag', scope: 'event', op: 'exact', values: [true] },
        { key: 'plan', scope: 'person', op: 'is_set', values: [] },
        { key: '$session_duration', scope: 'session', op: 'gt', values: [30] },
        { key: 'id', scope: 'cohort', op: 'in', values: [5] },
        { key: 'name', scope: 'group', op: 'icontains', values: ['shop'] },
        { key: 'properties.x = 1', scope: 'hogql', op: 'exact', values: [] },
        { key: 'tag_name', scope: 'element', op: 'exact', values: ['a'] },
        { key: 'beta', scope: 'other', op: 'flag_evaluates_to', values: [true] },
        { key: 'performed_event', scope: 'other', op: 'exact', values: ['performed_event'] },
      ],
    });
    expect(t.notChecked).toEqual([]);
  });

  it('adds fixedProperties, drops empty filters, and records filters it cannot read', () => {
    const t = one(
      [
        { type: 'empty' },
        { key: 'a', value: 1 },
        { type: 'event', value: 1 },
        { key: 'b', operator: 'is between', value: 1 },
        { key: 'c', value: [{ nested: true }] },
        'genre',
        { key: 42, value: 'numeric key' },
      ],
      { fixedProperties: [{ key: 'z', type: 'person', operator: 'exact', value: 'x' }] },
    );
    expect(t.series?.[0]?.node === 'event' && t.series[0].filters).toEqual([
      { key: 'a', scope: 'event', op: 'exact', values: [1] },
      { key: '42', scope: 'event', op: 'exact', values: ['numeric key'] },
      { key: 'z', scope: 'person', op: 'exact', values: ['x'] },
    ]);
    expect(t.notChecked).toEqual([
      {
        path: 'series[0].filters',
        reason: 'a property filter of type event with no key is not checked',
      },
      {
        path: 'series[0].filters',
        reason: 'property filter b has operator "is between" is not checked',
      },
      {
        path: 'series[0].filters',
        reason: 'property filter c has a value that is not a scalar is not checked',
      },
      {
        path: 'series[0].filters',
        reason: 'a property filter that is not an object is not checked',
      },
    ]);
  });

  it('reads PostHog property groups: AND of AND, OR of single filters, true members', () => {
    const f = (key: string): Raw => ({ key, type: 'event', operator: 'exact', value: key });
    const group = (type: string, values: unknown[]): Raw => ({ type, values });
    const insightFilters = (properties: unknown): Tile => tile(insight(trends([], { properties })));
    expect(insightFilters(group('AND', [group('AND', [f('a'), f('b')])])).filters).toEqual([
      { key: 'a', scope: 'event', op: 'exact', values: ['a'] },
      { key: 'b', scope: 'event', op: 'exact', values: ['b'] },
    ]);
    expect(
      insightFilters(group('AND', [group('OR', [f('a'), group('OR', [f('b'), f('c')])])])).filters,
    ).toEqual([
      {
        any: [
          { key: 'a', scope: 'event', op: 'exact', values: ['a'] },
          { key: 'b', scope: 'event', op: 'exact', values: ['b'] },
          { key: 'c', scope: 'event', op: 'exact', values: ['c'] },
        ],
      },
    ]);
    expect(insightFilters(group('OR', [group('AND', [f('a')])])).filters).toEqual([
      { key: 'a', scope: 'event', op: 'exact', values: ['a'] },
    ]);
    for (const alwaysTrue of [
      group('OR', [f('a'), group('AND', [])]),
      group('OR', [f('a'), { type: 'empty' }]),
      group('OR', []),
    ])
      expect(insightFilters(alwaysTrue)).toMatchObject({ filters: [], notChecked: [] });
  });

  it('an OR of AND groups, or an OR with an unreadable member, is not checked as a whole', () => {
    const f = (key: string): Raw => ({ key, value: key });
    const t = tile(
      insight(
        trends([], {
          properties: { type: 'OR', values: [{ type: 'AND', values: [f('a'), f('b')] }, f('c')] },
        }),
      ),
    );
    expect(t.filters).toEqual([]);
    expect(t.notChecked).toEqual([
      { path: 'filters', reason: 'an OR of AND groups is not checked' },
    ]);
    const u = tile(
      insight(trends([], { properties: { type: 'OR', values: [f('a'), { value: 1 }] } })),
    );
    expect(u.notChecked).toEqual([
      { path: 'filters', reason: 'an OR group with a member that is not checked is not checked' },
    ]);
    const v = tile(
      insight(
        trends([], {
          properties: [f('a'), { type: 'OR', values: [{ type: 'AND', values: [f('b'), f('c')] }] }],
        }),
      ),
    );
    expect(v.filters).toEqual([]);
    expect(tile(insight(trends([], { properties: 'genre' }))).notChecked).toEqual([
      { path: 'filters', reason: 'property filters that are not a list are not checked' },
    ]);
  });
});

describe('breakdowns', () => {
  const bd = (breakdownFilter: unknown): Tile =>
    tile(insight(trends([ev('a')], { breakdownFilter })));

  it('reads both forms, maps types, and an empty filter is no breakdown', () => {
    expect(
      bd({
        breakdowns: [
          { property: 'format' },
          { type: 'person', property: 'plan' },
          { type: 'event_metadata', property: 'distinct_id' },
        ],
      }).breakdown,
    ).toEqual([
      { key: 'format', scope: 'event' },
      { key: 'plan', scope: 'person' },
      { key: 'distinct_id', scope: 'other' },
    ]);
    expect(bd({ breakdown: 'genre', breakdown_type: 'session' }).breakdown).toEqual([
      { key: 'genre', scope: 'session' },
    ]);
    expect(bd({ breakdown: 'genre' }).breakdown).toEqual([{ key: 'genre', scope: 'event' }]);
    expect(bd({ breakdown: [3, 4], breakdown_type: 'cohort' }).breakdown).toEqual([
      { key: '3', scope: 'cohort' },
      { key: '4', scope: 'cohort' },
    ]);
    expect(bd({ breakdowns: [{ property: 'x' }], breakdown: 'legacy' }).breakdown).toEqual([
      { key: 'x', scope: 'event' },
    ]);
    for (const empty of [{ breakdown_type: 'event' }, { breakdowns: [], breakdown: '' }, null, {}])
      expect(bd(empty)).toMatchObject({ breakdown: [], notChecked: [] });
  });

  it('records breakdowns it cannot read', () => {
    expect(bd({ breakdowns: [{ type: 'event' }, { property: 'ok' }] })).toMatchObject({
      breakdown: [{ key: 'ok', scope: 'event' }],
      notChecked: [{ path: 'breakdown[0]', reason: 'a breakdown with no property is not checked' }],
    });
    expect(bd({ breakdown: [true] }).notChecked).toEqual([
      { path: 'breakdown', reason: 'breakdown true is not checked' },
    ]);
    expect(bd('genre').notChecked).toEqual([
      { path: 'breakdown', reason: 'a breakdown filter that is not an object is not checked' },
    ]);
  });
});

describe('formulas', () => {
  const fm = (trendsFilter: unknown): Tile =>
    tile(insight(trends([ev('a'), ev('b')], { trendsFilter })));

  it('formulaNodes win over formulas and formula; refs are distinct letters, sorted, upper case', () => {
    expect(
      fm({
        formulaNodes: [{ formula: 'B/A' }, { formula: 'a+a*2' }],
        formulas: ['A'],
        formula: 'B',
      }).formulas,
    ).toEqual([
      { index: 0, expression: 'B/A', refs: ['A', 'B'] },
      { index: 1, expression: 'a+a*2', refs: ['A'] },
    ]);
    expect(fm({ formulas: ['A-B', 'B'], formula: 'A' }).formulas).toEqual([
      { index: 0, expression: 'A-B', refs: ['A', 'B'] },
      { index: 1, expression: 'B', refs: ['B'] },
    ]);
    expect(fm({ formulaNodes: [], formula: 'A*100' }).formulas).toEqual([
      { index: 0, expression: 'A*100', refs: ['A'] },
    ]);
    for (const none of [{ formulaNodes: [] }, { formula: '' }, null, { formulas: [] }])
      expect(fm(none)).toMatchObject({ formulas: [], notChecked: [] });
  });

  it('keeps formula indexes when one is unreadable, and names tokens that are not letters', () => {
    const t = fm({
      formulaNodes: [
        { formula: 7 },
        { custom_name: 'x' },
        { formula: 'sqrt(A)' },
        { formula: 'B' },
      ],
    });
    expect(t.formulas).toEqual([
      { index: 2, expression: 'sqrt(A)', refs: [] },
      { index: 3, expression: 'B', refs: ['B'] },
    ]);
    expect(t.notChecked).toEqual([
      { path: 'formulas[0]', reason: 'a formula that is not text is not checked' },
      { path: 'formulas[2]', reason: 'formula sqrt(A) names something other than series letters' },
    ]);
  });
});

describe('outputs always validate and never throw', () => {
  // A small deterministic generator of PostHog-like junk: right keys, wrong or random values.
  let seed = 42;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const KEYS = [
    'kind',
    'event',
    'math',
    'math_property',
    'math_property_type',
    'properties',
    'fixedProperties',
    'nodes',
    'operator',
    'id',
    'table_name',
    'key',
    'type',
    'value',
    'values',
    'formula',
    'formulaNodes',
    'formulas',
    'breakdown',
    'breakdowns',
    'breakdown_type',
    'property',
    'version',
    'series',
    'dateRange',
    'date_from',
    'funnelFromStep',
    'funnelToStep',
    'exclusions',
    'funnelVizType',
    'targetEntity',
    'returningEntity',
    'aggregationType',
    'aggregationProperty',
    'name',
    'filters',
    'filters_overrides',
    'ignoreDashboardFilters',
    'breakdown_filter',
    'insight',
    'short_id',
    'deleted',
  ];
  const ATOMS: unknown[] = [
    null,
    undefined,
    '',
    'A',
    'a+B',
    'OR',
    'AND',
    'EventsNode',
    'GroupNode',
    'ActionsNode',
    'DataWarehouseNode',
    'empty',
    'event',
    'person',
    'cohort',
    'exact',
    'Weird Op',
    'actions',
    'events',
    'data_warehouse',
    'new_entity',
    'sum',
    'steps',
    '$pageview',
    'Zz000001',
    7,
    1,
    0,
    4,
    5,
    -1,
    2.5,
    true,
    false,
    [],
    {},
  ];
  const junk = (depth: number): unknown => {
    if (depth <= 0 || rnd() < 0.3) return pick(ATOMS);
    if (rnd() < 0.4) return Array.from({ length: Math.floor(rnd() * 4) }, () => junk(depth - 1));
    const o: Raw = {};
    for (let i = Math.floor(rnd() * 6); i > 0; i--) o[pick(KEYS)] = junk(depth - 1);
    return o;
  };

  it('500 random queries of each kind', () => {
    for (const kind of [
      'TrendsQuery',
      'LifecycleQuery',
      'StickinessQuery',
      'FunnelsQuery',
      'RetentionQuery',
    ]) {
      for (let i = 0; i < 500; i++) {
        const source = { ...(junk(4) as Raw), kind, version: pick([undefined, 1, 4, 5]) };
        if (rnd() < 0.7) source.series = Array.from({ length: 3 }, () => junk(4));
        if (kind === 'TrendsQuery') {
          source.trendsFilter = junk(3);
          source.breakdownFilter = junk(3);
        }
        if (kind === 'FunnelsQuery') {
          source.funnelsFilter = { ...(junk(3) as Raw), exclusions: junk(4) };
          source.breakdownFilter = junk(3);
        }
        if (kind === 'RetentionQuery')
          source.retentionFilter = {
            ...(junk(3) as Raw),
            targetEntity: junk(3),
            returningEntity: junk(3),
          };
        source.properties = junk(4);
        expect(() => tile(insight(source))).not.toThrow();
      }
    }
  });

  it('500 random dashboard sets', () => {
    for (let i = 0; i < 500; i++) {
      const dashboards = Array.from({ length: 3 }, () => ({
        ...(junk(3) as Raw),
        id: pick([1, 2, 'x', '', null]),
        filters: junk(4),
        tiles: [{ insight: { id: 7, short_id: 'Zz000001' }, filters_overrides: junk(4) }, junk(3)],
      }));
      const insights = [
        insight(trends([ev('book_viewed', { properties: junk(3) })], { properties: junk(3) }), {
          dashboards: junk(1),
        }),
        insight(
          { kind: 'RetentionQuery', retentionFilter: junk(3) },
          { id: 8, short_id: 'Zz000002' },
        ),
      ];
      let r: Requirements | undefined;
      expect(() => (r = normalizeInsights(insights, { ...ctx, dashboards }))).not.toThrow();
      expectValid(r as Requirements);
    }
  });
});

describe('recorded demo responses', () => {
  it('normalise to valid requirements; every trends and funnel tile is read', () => {
    const rec = JSON.parse(
      readFileSync(
        new URL('../../../fixtures/posthog-recorded/demo.json', import.meta.url),
        'utf8',
      ),
    ) as {
      recorded: { host: string; project: number };
      responses: Record<string, { results?: Raw[] }>;
    };
    const insights = Object.entries(rec.responses)
      .filter(([p]) => p.startsWith('insights/'))
      .flatMap(([, b]) => b.results ?? []);
    const dashboards = Object.entries(rec.responses)
      .filter(([p]) => /^dashboards\/\d+\/$/.test(p))
      .map(([, b]) => b);
    const r = normalizeInsights(insights, {
      host: rec.recorded.host,
      project: rec.recorded.project,
      dashboards,
    });
    expectValid(r);
    expect(r.dashboards?.map((d) => d.name)).toEqual(['Bookshop growth', 'Checkout', 'Mobile']);
    const trendsTiles = r.tiles.filter((t) => t.kind === 'trends');
    const funnelTiles = r.tiles.filter((t) => t.kind === 'funnels');
    expect(trendsTiles.length).toBeGreaterThan(20);
    expect(funnelTiles.length).toBeGreaterThan(0);
    for (const t of [...trendsTiles, ...funnelTiles])
      for (const n of t.notChecked ?? []) expect(n.reason).toMatch(/^action \d+ was not read$/);
    // The dashboard bodies' tiles agree with each insight's own list, and most tiles are on one.
    const own = new Map(
      insights.map((i) => [
        `insight:${String(i.short_id)}`,
        (i.dashboards as number[]).map((d) => `dashboard:${d}`).sort(),
      ]),
    );
    for (const t of r.tiles) expect(t.dashboards).toEqual(own.get(t.id));
    expect(r.tiles.filter((t) => (t.dashboards ?? []).length > 0).length).toBeGreaterThan(30);
  });
});
