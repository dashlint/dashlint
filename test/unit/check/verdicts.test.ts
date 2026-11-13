import { describe, expect, it } from 'vitest';
import {
  ACTION_STEP_UNSUPPORTED,
  ALL_EVENTS,
  AND_GROUP,
  DASHBOARD_FILTERS_DIFFER,
  FORMULA_SERIES_UNKNOWN,
  KIND_CUT,
  KIND_NOT_CHECKED,
  NO_LIVE_EVENT,
  NO_PARTS,
  PERSON_MATH_PROPERTY,
  SCOPE_NOT_CHECKED,
  WAREHOUSE_NODE,
  andEffect,
  checkTile,
  checkTiles,
  posthogProfile,
  type CheckContext,
  type CodeFacts,
  type CodeIndex,
  type RulesProfile,
} from '../../../src/check/index.js';
import {
  eventFact,
  mergeCatalogs,
  personPropertyFact,
  propertyFact,
} from '../../../src/extract/index.js';
import type { Catalog, CatalogEvent, PropertyFact } from '../../../src/formats/catalog.js';
import type {
  Filter,
  Observed,
  Requirements,
  SeriesNode,
  Tile,
} from '../../../src/formats/requirements.js';
import { validateCatalog } from '../../../src/formats/validate.js';

const PULLED = '2026-12-18T09:12:00Z';
const RECENT = '2026-12-17T08:00:00Z';

const always = (set: string[]): PropertyFact => ({
  presence: 'always',
  values: { kind: 'finite', set },
});

function event(
  line: number,
  properties: Record<string, PropertyFact>,
  platform = 'web',
): CatalogEvent {
  return {
    sites: [
      {
        file: `src/shop${line}.ts`,
        line,
        sdk: 'shop-sdk',
        via: [],
        platforms: [platform],
        openProperties: false,
      },
    ],
    openSites: 0,
    properties,
  };
}

/** The invented bookshop (spec 6.17): a closed source on one platform. */
function source(
  name: string,
  platform: string,
  events: Record<string, CatalogEvent>,
  conditional: string[] = [],
): Catalog {
  const c: Catalog = {
    schema: 'dashlint.catalog/1',
    tool: '0.0.0-test',
    source: {
      name,
      root: name,
      commit: null,
      platforms: [platform],
      sdks: [{ id: 'shop-sdk', version: '1.0.0', types: 'stub' }],
    },
    openWorld: [],
    events,
    superProperties: {},
    personProperties: {
      favourite_genre: { sites: [{ file: 'src/account.ts', line: 7, call: 'people.set' }] },
    },
    builtins: { events: [], properties: null, conditional, off: [] },
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

const web = () =>
  source(
    'web',
    'web',
    {
      wishlist_shared: event(41, { genre_id: always(['fiction', 'poetry']) }),
      order_completed: event(30, { format: always(['paperback', 'ebook']) }),
      giftcard_redeemed: event(88, {}),
    },
    ['shelf_opened'],
  );

const ios = () =>
  source('ios', 'ios', {
    order_completed: event(12, { format: always(['paperback', 'ebook']) }, 'ios'),
    book_scanned: event(19, {}, 'ios'),
  });

function context(
  catalogs: Catalog[] = [web()],
  profile: RulesProfile = posthogProfile,
  observed?: Observed,
): CheckContext {
  const m = mergeCatalogs(catalogs, new Map());
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
  return {
    facts: { code, ...(observed === undefined ? {} : { observed }), pulledAt: PULLED },
    index,
    profile,
  };
}

const ev = (
  name: string,
  extra: Partial<Extract<SeriesNode, { node: 'event' }>> = {},
): SeriesNode => ({
  node: 'event',
  event: name,
  ...extra,
});

const f = (key: string, op = 'exact', values: (string | number)[] = ['fiction']): Filter => ({
  key,
  scope: 'event',
  op,
  values,
});

/** Series lettered A, B, ... in order. */
function trends(series: SeriesNode[], extra: Partial<Tile> = {}): Tile {
  return {
    id: 'insight:shelf1',
    title: 'Shelf',
    kind: 'trends',
    series: series.map((s, i) => ({ ...s, ref: String.fromCharCode(65 + i) })),
    ...extra,
  };
}

function funnel(steps: SeriesNode[], extra: Partial<Tile> = {}): Tile {
  return { ...trends(steps, extra), kind: 'funnels' };
}

const live = 'wishlist_shared';
const dead = 'gift_card_redeemed';
const unknownEvent = 'shelf_opened';

describe('event node (spec 6.7.3)', () => {
  it('a live event: live, no finding', () => {
    const r = checkTile(context(), trends([ev(live)]));
    expect(r).toMatchObject({
      verdict: 'live',
      platforms: ['web'],
      findings: [],
      unknownParts: [],
    });
    expect(r.parts).toEqual([{ path: 'series[0]', role: 'series', effect: 'live' }]);
  });

  it('a dead event: dead, with the event finding; its filters are not checked', () => {
    // A person property is the same on every event: only the early stop keeps its finding out.
    const shelf: Filter = { key: 'favourite_shelf', scope: 'person', op: 'exact', values: ['a'] };
    const observed: Observed = {
      windowDays: 30,
      events: {},
      personProperties: { seen: ['favourite_genre'], notSeen: ['favourite_shelf'] },
    };
    const onLive = checkTile(
      context([web()], posthogProfile, observed),
      trends([ev(live, { filters: [shelf] })]),
    );
    expect(onLive.findings[0]).toMatchObject({ property: 'favourite_shelf', effect: 'dead' });
    const r = checkTile(
      context([web()], posthogProfile, observed),
      trends([ev(dead, { filters: [f('genre'), shelf] })]),
    );
    expect(r.verdict).toBe('dead');
    expect(r.platforms).toEqual([]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      check: 'event-has-call-site',
      path: 'series[0]',
      effect: 'dead',
      hint: { closestEvent: 'giftcard_redeemed' },
    });
  });

  it('any dead filter makes the node dead', () => {
    const r = checkTile(context(), trends([ev(live, { filters: [f('genre_id'), f('genre')] })]));
    expect(r.verdict).toBe('dead');
    expect(r.findings).toEqual([
      expect.objectContaining({
        check: 'property-is-sent',
        path: 'series[0].filters[1]',
        effect: 'dead',
      }),
    ]);
  });

  it('a filter with no effect makes it degraded', () => {
    const r = checkTile(context(), trends([ev(live, { filters: [f('genre', 'is_not')] })]));
    expect(r.verdict).toBe('degraded');
    expect(r.findings[0]).toMatchObject({ effect: 'degraded', path: 'series[0].filters[0]' });
  });

  it('an unknown filter makes it unknown unless it is already dead', () => {
    const sess: Filter = { key: 'shelf', scope: 'session', op: 'exact', values: ['x'] };
    const unknown = checkTile(context(), trends([ev(live, { filters: [sess] })]));
    expect(unknown.verdict).toBe('not-checked');
    expect(unknown.unknownParts).toEqual([{ path: 'series[0]', reasons: [SCOPE_NOT_CHECKED] }]);
    expect(unknown.reasons).toBeUndefined();
    const deadToo = checkTile(context(), trends([ev(live, { filters: [sess, f('genre')] })]));
    expect(deadToo.verdict).toBe('dead');
    expect(deadToo.unknownParts).toEqual([]);
    const degraded = checkTile(
      context(),
      trends([ev(live, { filters: [f('genre', 'is_not'), sess] })]),
    );
    expect(degraded.verdict).toBe('not-checked');
  });

  it('a value the code never sends is dead through value-is-reachable', () => {
    const r = checkTile(
      context(),
      trends([ev(live, { filters: [f('genre_id', 'exact', ['drama'])] })]),
    );
    expect(r.verdict).toBe('dead');
    expect(r.findings[0]).toMatchObject({ check: 'value-is-reachable', effect: 'dead' });
  });

  it('an unknown event: unknown, but a dead filter on it still decides', () => {
    const r = checkTile(context(), trends([ev(unknownEvent)]));
    expect(r.verdict).toBe('not-checked');
    expect(r.unknownParts).toEqual([{ path: 'series[0]', reasons: ['conditional-builtin'] }]);
  });

  it('a dead event-scope math property is dead; a person one is unknown', () => {
    const math = (scope: 'event' | 'person') =>
      checkTile(
        context(),
        trends([ev(live, { math: 'sum', mathProperty: { key: 'price', scope } })]),
      );
    expect(math('event').verdict).toBe('dead');
    expect(math('event').findings[0]).toMatchObject({ path: 'series[0].mathProperty' });
    expect(math('person').unknownParts).toEqual([
      { path: 'series[0]', reasons: [PERSON_MATH_PROPERTY] },
    ]);
  });

  it('AND table: dead, then unknown, then degraded', () => {
    expect(andEffect([])).toBe('live');
    expect(andEffect(['live', 'degraded'])).toBe('degraded');
    expect(andEffect(['degraded', 'unknown'])).toBe('unknown');
    expect(andEffect(['unknown', 'dead', 'degraded'])).toBe('dead');
  });
});

describe('group, all-events, action and warehouse nodes', () => {
  const group = (events: { event: string; filters?: Filter[] }[], operator: 'OR' | 'AND' = 'OR') =>
    ({ node: 'group', operator, events }) as SeriesNode;

  it('OR group: live when one member is live; a dead member is an info line', () => {
    const r = checkTile(context(), trends([group([{ event: dead }, { event: live }])]));
    expect(r.verdict).toBe('live');
    expect(r.findings).toEqual([
      expect.objectContaining({ path: 'series[0].events[0]', effect: 'info', event: dead }),
    ]);
  });

  it('OR group: dead when every member is dead', () => {
    const r = checkTile(
      context(),
      trends([group([{ event: dead }, { event: live, filters: [f('genre')] }])]),
    );
    expect(r.verdict).toBe('dead');
    expect(r.findings.map((x) => [x.path, x.effect])).toEqual([
      ['series[0].events[0]', 'dead'],
      ['series[0].events[1].filters[0]', 'dead'],
    ]);
  });

  it('OR group: otherwise unknown', () => {
    const r = checkTile(context(), trends([group([{ event: dead }, { event: unknownEvent }])]));
    expect(r.verdict).toBe('not-checked');
    expect(r.unknownParts).toEqual([{ path: 'series[0]', reasons: ['conditional-builtin'] }]);
  });

  it('AND group is not checked', () => {
    const r = checkTile(context(), trends([group([{ event: live }], 'AND')]));
    expect(r.unknownParts).toEqual([{ path: 'series[0]', reasons: [AND_GROUP] }]);
  });

  it('all-events: live; its event-scope filters are unknown', () => {
    expect(checkTile(context(), trends([{ node: 'all-events' }])).verdict).toBe('live');
    const r = checkTile(context(), trends([{ node: 'all-events', filters: [f('genre_id')] }]));
    expect(r.unknownParts).toEqual([{ path: 'series[0]', reasons: [ALL_EVENTS] }]);
    const person: Filter = { key: 'favourite_genre', scope: 'person', op: 'is_set', values: [] };
    expect(checkTile(context(), trends([{ node: 'all-events', filters: [person] }])).verdict).toBe(
      'live',
    );
  });

  it('action: a group over its steps', () => {
    const action = (
      steps: { event: string | null; filters?: Filter[]; unsupported?: string[] }[],
    ) => ({ node: 'action', action: { id: 7, name: 'Bought', steps } }) as SeriesNode;
    expect(checkTile(context(), trends([action([{ event: dead }, { event: live }])])).verdict).toBe(
      'live',
    );
    const allDead = checkTile(
      context(),
      trends([action([{ event: dead }, { event: 'gift_cards' }])]),
    );
    expect(allDead.verdict).toBe('dead');
    expect(allDead.findings.map((x) => x.path)).toEqual([
      'series[0].steps[0]',
      'series[0].steps[1]',
    ]);
    expect(checkTile(context(), trends([action([{ event: null }])])).verdict).toBe('live');
    const unsupported = checkTile(
      context(),
      trends([action([{ event: live, unsupported: ['url'] }, { event: dead }])]),
    );
    expect(unsupported.unknownParts).toEqual([
      { path: 'series[0]', reasons: [ACTION_STEP_UNSUPPORTED] },
    ]);
    // An unsupported matcher on a dead event: the step is still dead (AND).
    expect(
      checkTile(context(), trends([action([{ event: dead, unsupported: ['url'] }])])).verdict,
    ).toBe('dead');
  });

  it('warehouse nodes are never checked', () => {
    const r = checkTile(context(), trends([{ node: 'warehouse', table: 'stock' }]));
    expect(r.unknownParts).toEqual([{ path: 'series[0]', reasons: [WAREHOUSE_NODE] }]);
  });
});

describe('trends, lifecycle and stickiness: tile precedence', () => {
  it('every decided part dead: dead, with the unknown parts counted', () => {
    const r = checkTile(context(), trends([ev(dead), ev(unknownEvent)]));
    expect(r.verdict).toBe('dead');
    expect(r.unknownParts).toHaveLength(1);
  });

  it('one dead part next to a live one: partly dead', () => {
    expect(checkTile(context(), trends([ev(live), ev(dead)])).verdict).toBe('partly-dead');
  });

  it('partly dead beats degraded, degraded beats live', () => {
    const deg = ev(live, { filters: [f('genre', 'is_not')] });
    expect(checkTile(context(), trends([ev(dead), deg])).verdict).toBe('partly-dead');
    expect(checkTile(context(), trends([ev(live), deg])).verdict).toBe('degraded');
  });

  it('live with an unknown part: live, and the part is counted', () => {
    const r = checkTile(context(), trends([ev(live), ev(unknownEvent)]));
    expect(r.verdict).toBe('live');
    expect(r.unknownParts).toEqual([{ path: 'series[1]', reasons: ['conditional-builtin'] }]);
  });

  it('no series at all: not checked', () => {
    const r = checkTile(context(), trends([]));
    expect(r).toMatchObject({ verdict: 'not-checked', reasons: [NO_PARTS] });
  });

  it('lifecycle and stickiness follow the same rules', () => {
    for (const kind of ['lifecycle', 'stickiness'] as const) {
      expect(checkTile(context(), { ...trends([ev(dead)]), kind }).verdict).toBe('dead');
      expect(checkTile(context(), { ...trends([ev(live), ev(dead)]), kind }).verdict).toBe(
        'partly-dead',
      );
    }
  });

  it('a cut turns lifecycle, stickiness and retention tiles into not checked', () => {
    const cut = {
      ...posthogProfile,
      notCheckedKinds: ['lifecycle', 'stickiness', 'retention'] as const,
    };
    const ctx = context([web()], cut);
    for (const kind of ['lifecycle', 'stickiness', 'retention'] as const)
      expect(checkTile(ctx, { ...trends([ev(dead)]), kind })).toMatchObject({
        verdict: 'not-checked',
        reasons: [KIND_CUT],
        findings: [],
      });
    expect(checkTile(ctx, trends([ev(dead)])).verdict).toBe('dead');
  });

  it('paths, sql and other tiles are not checked', () => {
    for (const kind of ['paths', 'sql', 'other'] as const)
      expect(
        checkTile(context(), { id: 't', title: 'x', kind, notChecked: [{ reason: 'sql tile' }] }),
      ).toMatchObject({ verdict: 'not-checked', reasons: [KIND_NOT_CHECKED, 'sql tile'] });
  });
});

describe('formulas', () => {
  it('negative control: A/B with dead B is dead', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev(dead)], {
        formulas: [{ index: 0, expression: 'A/B', refs: ['A', 'B'] }],
      }),
    );
    expect(r.verdict).toBe('dead');
    expect(r.parts).toEqual([{ path: 'formulas[0]', role: 'formula', effect: 'dead' }]);
    expect(r.findings[0]).toMatchObject({ path: 'series[1]', effect: 'dead' });
  });

  it('negative control: A+B with dead B is partly dead', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev(dead)], {
        formulas: [{ index: 0, expression: 'A+B', refs: ['A', 'B'] }],
      }),
    );
    expect(r.verdict).toBe('partly-dead');
    expect(r.parts[0]?.effect).toBe('partly-dead');
  });

  it('PostHog shows only formulas: a hidden dead series changes nothing', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev(live), ev(dead)], {
        formulas: [{ index: 0, expression: 'A/B', refs: ['A', 'B'] }],
      }),
    );
    expect(r.verdict).toBe('live');
    expect(r.findings).toEqual([]);
    expect(r.series.map((s) => s.effect)).toEqual(['live', 'live', 'dead']);
  });

  it('a dead series a live formula ignores is an info line', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev(dead)], {
        formulas: [{ index: 0, expression: 'A+0*B', refs: ['A', 'B'] }],
      }),
    );
    expect(r.verdict).toBe('live');
    expect(r.findings[0]).toMatchObject({ path: 'series[1]', effect: 'info' });
  });

  it('an unknown series makes the formula unknown, with the series reasons', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev(unknownEvent)], {
        formulas: [{ index: 0, expression: 'A+B', refs: ['A', 'B'] }],
      }),
    );
    expect(r.verdict).toBe('not-checked');
    expect(r.unknownParts).toEqual([
      { path: 'formulas[0]', reasons: ['conditional-builtin', FORMULA_SERIES_UNKNOWN] },
    ]);
  });

  it('two formulas: each a part', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev(dead)], {
        formulas: [
          { index: 0, expression: 'B*2', refs: ['B'] },
          { index: 1, expression: 'A*2', refs: ['A'] },
        ],
      }),
    );
    expect(r.verdict).toBe('partly-dead');
  });

  it('an unreadable formula is an unknown part', () => {
    const r = checkTile(
      context(),
      trends([ev(live)], {
        formulas: [{ index: 1, expression: 'A', refs: ['A'] }],
        notChecked: [{ path: 'formulas[0]', reason: 'a formula that is not text is not checked' }],
      }),
    );
    expect(r.verdict).toBe('live');
    expect(r.unknownParts).toEqual([
      { path: 'formulas[0]', reasons: ['a formula that is not text is not checked'] },
    ]);
    const fn = checkTile(
      context(),
      trends([ev(dead)], {
        formulas: [{ index: 0, expression: 'sqrt(A)', refs: [] }],
        notChecked: [{ path: 'formulas[0]', reason: 'function' }],
      }),
    );
    expect(fn.verdict).toBe('not-checked');
    expect(fn.findings).toEqual([]);
  });
});

describe('funnels', () => {
  it('first step dead: dead', () => {
    const r = checkTile(context(), funnel([ev(dead), ev(live)]));
    expect(r.verdict).toBe('dead');
    expect(r.deadFrom).toBeUndefined();
  });

  it('a later step dead: partly dead, steps k to n are always zero', () => {
    const r = checkTile(context(), funnel([ev(live), ev('order_completed'), ev(dead), ev(live)]));
    expect(r).toMatchObject({ verdict: 'partly-dead', deadFrom: 3 });
    const unknownFirst = checkTile(context(), funnel([ev(unknownEvent), ev(dead)]));
    expect(unknownFirst).toMatchObject({ verdict: 'partly-dead', deadFrom: 2 });
  });

  it('every step live: live; a degraded step: degraded; all unknown: not checked', () => {
    expect(checkTile(context(), funnel([ev(live), ev('order_completed')])).verdict).toBe('live');
    expect(
      checkTile(context(), funnel([ev(live), ev(live, { filters: [f('genre', 'is_not')] })]))
        .verdict,
    ).toBe('degraded');
    expect(checkTile(context(), funnel([ev(unknownEvent)])).verdict).toBe('not-checked');
  });

  it('a dead exclusion has no effect: degraded', () => {
    const r = checkTile(
      context(),
      funnel([ev(live), ev('order_completed')], {
        exclusions: [{ node: 'event', event: dead, fromStep: 0, toStep: 1 }],
      }),
    );
    expect(r.verdict).toBe('degraded');
    expect(r.parts.at(-1)).toEqual({
      path: 'exclusions[0]',
      role: 'exclusion',
      effect: 'degraded',
    });
    expect(r.findings[0]).toMatchObject({ path: 'exclusions[0]', effect: 'degraded' });
  });

  it('a live exclusion: live; an unknown one is counted', () => {
    const exclusions: SeriesNode[] = [
      { node: 'event', event: 'giftcard_redeemed', fromStep: 0, toStep: 1 },
      { node: 'event', event: unknownEvent, fromStep: 0, toStep: 1 },
    ];
    const r = checkTile(context(), funnel([ev(live), ev('order_completed')], { exclusions }));
    expect(r.verdict).toBe('live');
    expect(r.unknownParts).toEqual([{ path: 'exclusions[1]', reasons: ['conditional-builtin'] }]);
  });

  it('a dead funnel does not check its exclusions or breakdown', () => {
    const r = checkTile(
      context(),
      funnel([ev(dead)], {
        exclusions: [{ node: 'event', event: unknownEvent, fromStep: 0, toStep: 1 }],
        breakdown: [{ key: 'genre', scope: 'event' }],
      }),
    );
    expect(r).toMatchObject({ verdict: 'dead', unknownParts: [] });
    expect(r.findings).toHaveLength(1);
  });

  it('unknown steps never make it live: modifiers alone give degraded or not checked', () => {
    const r = checkTile(
      context(),
      funnel([ev(unknownEvent)], {
        exclusions: [{ node: 'event', event: dead, fromStep: 0, toStep: 1 }],
      }),
    );
    expect(r.verdict).toBe('degraded');
    const live2 = checkTile(
      context(),
      funnel([ev(unknownEvent)], {
        exclusions: [{ node: 'event', event: live, fromStep: 0, toStep: 1 }],
      }),
    );
    expect(live2.verdict).toBe('not-checked');
  });
});

describe('retention', () => {
  const retention = (
    target: SeriesNode,
    returning: SeriesNode,
    extra: Partial<Tile> = {},
  ): Tile => ({
    id: 'insight:ret1',
    title: 'Returning readers',
    kind: 'retention',
    retention: { target, returning },
    ...extra,
  });

  it('target dead: dead; returning dead: partly dead; both live: live', () => {
    expect(checkTile(context(), retention(ev(dead), ev(live))).verdict).toBe('dead');
    const partly = checkTile(context(), retention(ev(live), ev(dead)));
    expect(partly.verdict).toBe('partly-dead');
    expect(partly.findings[0]).toMatchObject({ path: 'retention.returning' });
    expect(checkTile(context(), retention({ node: 'all-events' }, ev(live))).verdict).toBe('live');
  });

  it('unknown entities: counted; both unknown: not checked', () => {
    const r = checkTile(context(), retention(ev(live), ev(unknownEvent)));
    expect(r.verdict).toBe('live');
    expect(r.unknownParts.map((u) => u.path)).toEqual(['retention.returning']);
    expect(checkTile(context(), retention(ev(unknownEvent), ev(unknownEvent))).verdict).toBe(
      'not-checked',
    );
    const entry = checkTile(
      context(),
      retention(ev(live), ev(live), {
        notChecked: [{ path: 'retention.target', reason: 'groups entity' }],
      }),
    );
    expect(entry.unknownParts).toEqual([{ path: 'retention.target', reasons: ['groups entity'] }]);
  });
});

describe('breakdowns', () => {
  it('a key never sent on any live event: degraded', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev('order_completed')], { breakdown: [{ key: 'genre', scope: 'event' }] }),
    );
    expect(r.verdict).toBe('degraded');
    expect(r.findings[0]).toMatchObject({
      check: 'property-is-sent',
      path: 'breakdown[0]',
      effect: 'degraded',
    });
  });

  it('sent on some live events: live with an info line', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev('order_completed')], {
        breakdown: [{ key: 'genre_id', scope: 'event' }],
      }),
    );
    expect(r.verdict).toBe('live');
    expect(r.findings[0]).toMatchObject({ effect: 'info', path: 'breakdown[0]' });
  });

  it('only live parts count: a dead series does not make the breakdown degraded', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev(dead)], { breakdown: [{ key: 'genre_id', scope: 'event' }] }),
    );
    expect(r.verdict).toBe('partly-dead');
    expect(r.parts.at(-1)).toEqual({ path: 'breakdown[0]', role: 'breakdown', effect: 'live' });
  });

  it('no live part: the breakdown is an unknown part', () => {
    const r = checkTile(
      context(),
      trends([ev(unknownEvent)], { breakdown: [{ key: 'genre_id', scope: 'event' }] }),
    );
    expect(r.verdict).toBe('not-checked');
    expect(r.unknownParts.at(-1)).toEqual({ path: 'breakdown[0]', reasons: [NO_LIVE_EVENT] });
  });

  it('a breakdown PostHog may replace is not checked', () => {
    const r = checkTile(
      context(),
      trends([ev(live)], {
        breakdown: [{ key: 'genre', scope: 'event' }],
        notChecked: [{ path: 'breakdown', reason: 'dashboard:3 breakdown' }],
      }),
    );
    expect(r.verdict).toBe('live');
    expect(r.unknownParts).toEqual([{ path: 'breakdown', reasons: ['dashboard:3 breakdown'] }]);
  });
});

describe('one platform', () => {
  it('two platforms, every live event from one: one platform', () => {
    const r = checkTile(context([web(), ios()]), trends([ev(live)]));
    expect(r).toMatchObject({ verdict: 'one-platform', platforms: ['web'] });
  });

  it('an event on every platform: live, both platforms shown', () => {
    const r = checkTile(context([web(), ios()]), trends([ev('order_completed')]));
    expect(r).toMatchObject({ verdict: 'live', platforms: ['ios', 'web'] });
  });

  it('events from two different single platforms: live', () => {
    const r = checkTile(context([web(), ios()]), trends([ev(live), ev('book_scanned')]));
    expect(r.verdict).toBe('live');
  });

  it('all-events nodes and events sent on every platform do not count', () => {
    const ctx = context([web(), ios()]);
    expect(checkTile(ctx, trends([{ node: 'all-events' }, ev(live)])).verdict).toBe('one-platform');
    expect(checkTile(ctx, trends([ev('order_completed'), ev(live)])).verdict).toBe('one-platform');
    expect(checkTile(ctx, trends([{ node: 'all-events' }])).verdict).toBe('live');
  });

  it('one catalog platform: never one platform', () => {
    expect(checkTile(context(), trends([ev(live)])).verdict).toBe('live');
  });

  it('an event only PostHog sees has no known platform', () => {
    const observed: Observed = {
      windowDays: 30,
      events: { shelf_dusted: { defined: true, lastSeenAt: RECENT } },
    };
    const r = checkTile(
      context([web(), ios()], posthogProfile, observed),
      trends([ev('shelf_dusted'), ev(live)]),
    );
    expect(r.verdict).toBe('live');
  });

  it('only an otherwise live tile is one platform', () => {
    const ctx = context([web(), ios()]);
    const r = checkTile(ctx, trends([ev(live)], { breakdown: [{ key: 'genre', scope: 'event' }] }));
    expect(r.verdict).toBe('degraded');
    expect(checkTile(ctx, trends([ev(live), ev(dead)])).verdict).toBe('partly-dead');
  });
});

describe('tile filters, dashboards and not-checked entries', () => {
  it('tile filters apply to every series', () => {
    const r = checkTile(
      context(),
      trends([ev(live), ev('order_completed')], { filters: [f('format', 'exact', ['ebook'])] }),
    );
    expect(r.verdict).toBe('partly-dead');
    expect(r.findings[0]).toMatchObject({ path: 'filters[0]', event: live, effect: 'dead' });
  });

  it('dashboard filters apply to the tiles on that dashboard', () => {
    const tile = trends([ev(live)], { dashboards: ['dashboard:2'] });
    const r = checkTile(context(), tile, [{ id: 'dashboard:2', filters: [f('genre')] }]);
    expect(r.verdict).toBe('dead');
    expect(r.findings[0]?.path).toBe('dashboards[dashboard:2].filters[0]');
    expect(checkTile(context(), tile, [{ id: 'dashboard:2' }]).verdict).toBe('live');
  });

  it('dashboards whose filters differ: unknown', () => {
    const tile = trends([ev(live)], { dashboards: ['dashboard:2', 'dashboard:3'] });
    const r = checkTile(context(), tile, [
      { id: 'dashboard:2', filters: [f('genre')] },
      { id: 'dashboard:3' },
    ]);
    expect(r.verdict).toBe('not-checked');
    expect(r.unknownParts).toEqual([{ path: 'series[0]', reasons: [DASHBOARD_FILTERS_DIFFER] }]);
    const same = checkTile(context(), tile, [
      { id: 'dashboard:2', filters: [f('genre')] },
      { id: 'dashboard:3', filters: [f('genre')] },
    ]);
    expect(same.verdict).toBe('dead');
  });

  it('a not-checked entry on filters leaves the shared filters unchecked', () => {
    const r = checkTile(
      context(),
      trends([ev(live)], {
        filters: [f('genre')],
        notChecked: [{ path: 'filters', reason: 'an OR of AND groups is not checked' }],
      }),
    );
    expect(r.verdict).toBe('not-checked');
    expect(r.findings).toEqual([]);
    expect(r.unknownParts).toEqual([
      { path: 'series[0]', reasons: ['an OR of AND groups is not checked'] },
    ]);
  });

  it('an entry on a series makes it unknown unless it is dead', () => {
    const entry = (path: string) => [{ path, reason: 'math hogql' }];
    expect(
      checkTile(context(), trends([ev(live)], { notChecked: entry('series[0].math') })),
    ).toMatchObject({
      verdict: 'not-checked',
      unknownParts: [{ path: 'series[0]', reasons: ['math hogql'] }],
    });
    expect(
      checkTile(context(), trends([ev(dead)], { notChecked: entry('series[0].filters') })).verdict,
    ).toBe('dead');
    // series[1] is not series[10]
    const eleven = Array.from({ length: 11 }, () => ev(live));
    const r = checkTile(context(), trends(eleven, { notChecked: entry('series[10]') }));
    expect(r.unknownParts.map((u) => u.path)).toEqual(['series[10]']);
    // Two entries on one series: one part, both reasons; an entry past the last series is its own.
    const two = checkTile(
      context(),
      trends([ev(live)], {
        notChecked: [
          { path: 'series[0].math', reason: 'b' },
          { path: 'series[0].filters', reason: 'a' },
          { path: 'series[3]', reason: 'c' },
        ],
      }),
    );
    expect(two.unknownParts).toEqual([
      { path: 'series[0]', reasons: ['a', 'b'] },
      { path: 'series[3]', reasons: ['c'] },
    ]);
  });

  it('entries on exclusions: the whole list, one exclusion, or one that was left out', () => {
    const exclusions: SeriesNode[] = [{ node: 'event', event: dead, fromStep: 0, toStep: 1 }];
    const r = checkTile(
      context(),
      funnel([ev(live), ev('order_completed')], {
        exclusions,
        notChecked: [
          { path: 'exclusions', reason: 'exclusion 1 with funnelFromStep 4 is not checked' },
          { path: 'exclusions[0].filters', reason: 'cohort filter' },
          { path: 'exclusions[2]', reason: 'series node kind x' },
        ],
      }),
    );
    // A dead exclusion stays "no effect" next to an unreadable filter on it.
    expect(r.verdict).toBe('degraded');
    expect(r.unknownParts).toEqual([
      { path: 'exclusions', reasons: ['exclusion 1 with funnelFromStep 4 is not checked'] },
      { path: 'exclusions[2]', reasons: ['series node kind x'] },
    ]);
    const liveExclusion = checkTile(
      context(),
      funnel([ev(live), ev('order_completed')], {
        exclusions: [{ node: 'event', event: live, fromStep: 0, toStep: 1 }],
        notChecked: [{ path: 'exclusions[0].filters', reason: 'cohort filter' }],
      }),
    );
    expect(liveExclusion.unknownParts).toEqual([
      { path: 'exclusions[0]', reasons: ['cohort filter'] },
    ]);
  });

  it('a whole-tile entry: not checked; an unplaced entry: an unknown part', () => {
    expect(
      checkTile(context(), trends([ev(dead)], { notChecked: [{ reason: 'too many series' }] })),
    ).toMatchObject({
      verdict: 'not-checked',
      reasons: ['too many series'],
      findings: [],
    });
    const r = checkTile(
      context(),
      trends([ev(live)], { notChecked: [{ path: 'retention', reason: 'sum' }] }),
    );
    expect(r.verdict).toBe('live');
    expect(r.unknownParts).toEqual([{ path: 'retention', reasons: ['sum'] }]);
  });

  it('checkTiles keeps the order and passes the dashboards', () => {
    const req: Requirements = {
      schema: 'dashlint.requirements/1',
      source: { platform: 'posthog' },
      dashboards: [{ id: 'dashboard:2', filters: [f('genre')] }],
      tiles: [
        trends([ev(live)], { id: 'a', dashboards: ['dashboard:2'] }),
        trends([ev(live)], { id: 'b' }),
      ],
    };
    expect(checkTiles(context(), req).map((t) => [t.id, t.verdict])).toEqual([
      ['a', 'dead'],
      ['b', 'live'],
    ]);
  });
});
