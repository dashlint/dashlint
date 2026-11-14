import { describe, expect, it } from 'vitest';
import {
  NO_VALUES,
  REGEX_VALUES,
  SEVERAL_CONTAINS_VALUES,
  VALUE_NOT_COMPARABLE,
  checkFilter,
  genericProfile,
  posthogProfile,
  type CheckContext,
  type CodeFacts,
  type CodeIndex,
  type FilterCheck,
  type RulesProfile,
} from '../../../src/check/index.js';
import {
  eventFact,
  mergeCatalogs,
  personPropertyFact,
  propertyFact,
} from '../../../src/extract/index.js';
import type {
  Catalog,
  CatalogEvent,
  JsonScalar,
  PropertyFact,
  SuperProperty,
} from '../../../src/formats/catalog.js';
import type { Observed, PropertyFilter, Scope } from '../../../src/formats/requirements.js';
import { validateCatalog } from '../../../src/formats/validate.js';

const PULLED = '2026-12-18T09:12:00Z';
const RECENT = '2026-12-17T08:00:00Z';

const finite = (
  set: JsonScalar[],
  presence: PropertyFact['presence'] = 'always',
): PropertyFact => ({
  presence,
  values: { kind: 'finite', set },
});

function event(line: number, properties: Record<string, PropertyFact>, open = false): CatalogEvent {
  return {
    sites: [
      {
        file: `src/shop${line}.ts`,
        line,
        sdk: 'shop-sdk',
        via: [],
        platforms: ['web'],
        openProperties: open,
      },
    ],
    openSites: open ? 1 : 0,
    properties,
  };
}

const BOOKSHOP: Record<string, CatalogEvent> = {
  order_completed: event(30, {
    format: finite(['ebook', 'paperback']),
    gift_wrapped: finite([false, true]),
    quantity: finite([1, 2]),
    coupon: { presence: 'sometimes', values: { kind: 'open', type: 'string' } },
  }),
  wishlist_shared: event(41, { genre_id: finite(['fiction', 'poetry']) }),
};

interface Shop {
  name?: string;
  events?: Record<string, CatalogEvent>;
  superProperties?: Record<string, SuperProperty>;
  openSuperSites?: number;
}

/** The invented bookshop (spec 6.17): one closed web source. */
function shop(parts: Shop = {}): Catalog {
  const c: Catalog = {
    schema: 'dashlint.catalog/1',
    tool: '0.0.0-test',
    source: {
      name: parts.name ?? 'web',
      root: parts.name ?? 'web',
      commit: null,
      platforms: ['web'],
      sdks: [{ id: 'shop-sdk', version: '1.0.0', types: 'stub' }],
    },
    openWorld: [],
    events: parts.events ?? BOOKSHOP,
    superProperties: parts.superProperties ?? {},
    personProperties: {
      favourite_genre: { sites: [{ file: 'src/account.ts', line: 7, call: 'people.set' }] },
    },
    builtins: { events: [], properties: null, conditional: [], off: [] },
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
      openSuperSites: parts.openSuperSites ?? 0,
      openPersonSites: 0,
    },
  };
  const v = validateCatalog(c);
  if (!v.ok) throw new Error(`invalid test catalog: ${JSON.stringify(v.errors)}`);
  return c;
}

/** Code facts and the code index from the real merge, as the CLI will build them (T7.4). */
function context(
  catalogs: Catalog[] = [shop()],
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
    sites: (e) => (merged(e)?.sites ?? []).map((s) => ({ file: `web/${s.file}`, line: s.line })),
    platforms: m.platforms,
    eventPlatforms: (e) => merged(e)?.platforms ?? [],
  };
  return {
    facts: { code, ...(observed === undefined ? {} : { observed }), pulledAt: PULLED },
    index,
    profile,
  };
}

function filter(
  key: string,
  op: string,
  values: JsonScalar[],
  scope: Scope = 'event',
): PropertyFilter {
  return { key, scope, op, values };
}

function check(
  f: PropertyFilter,
  ctx: CheckContext = context(),
  event = 'order_completed',
): FilterCheck {
  return checkFilter(ctx, event, f, 'series[0].filters[0]');
}

const value = (r: FilterCheck) => r.checks[0]?.value;

describe('value-is-reachable: exact', () => {
  it('every value the code sends: live, no finding', () => {
    const r = check(filter('format', 'exact', ['ebook', 'paperback']));
    expect(r.effect).toBe('live');
    expect(value(r)).toEqual({
      op: 'exact',
      values: ['ebook', 'paperback'],
      effect: 'live',
      unreachable: [],
    });
    expect(r.reasons).toBeUndefined();
  });

  it('no value the code sends: dead, with the values the code sends as the hint', () => {
    const r = check(filter('format', 'exact', ['audiobook']));
    expect(r.effect).toBe('dead');
    expect(r.checks[0]).toMatchObject({ sent: 'yes', effect: 'dead' });
    expect(r.checks[0]?.finding).toBeUndefined();
    expect(value(r)?.finding).toEqual({
      check: 'value-is-reachable',
      path: 'series[0].filters[0]',
      effect: 'dead',
      event: 'order_completed',
      property: 'format',
      values: ['audiobook'],
      code: 'yes',
      sites: [{ file: 'web/src/shop30.ts', line: 30 }],
      hint: { reachableValues: ['ebook', 'paperback'] },
      detail: { role: 'filter', scope: 'event', op: 'exact', unreachable: ['audiobook'] },
    });
  });

  it('some values unreachable: degraded, listing only those', () => {
    const r = check(filter('format', 'exact', ['audiobook', 'ebook', 'hardback']));
    expect(r.effect).toBe('degraded');
    expect(value(r)).toMatchObject({ effect: 'degraded', unreachable: ['audiobook', 'hardback'] });
    expect(value(r)?.reasons).toBeUndefined();
    expect(value(r)?.finding).toMatchObject({
      effect: 'degraded',
      values: ['audiobook', 'ebook', 'hardback'],
      detail: { unreachable: ['audiobook', 'hardback'] },
    });
  });

  it('a case-only difference is dead in posthog (V3 R4, reproduced) and unknown in generic', () => {
    const r = check(filter('format', 'exact', ['Ebook']));
    expect(r.effect).toBe('dead');
    expect(value(r)?.finding).toMatchObject({ effect: 'dead', detail: { unreachable: ['Ebook'] } });
    const generic = check(filter('format', 'exact', ['Ebook']), context([shop()], genericProfile));
    expect(generic).toMatchObject({ effect: 'unknown', reasons: [VALUE_NOT_COMPARABLE] });
  });

  it('negative control: "true" against [true, false] is unknown, never dead, in both profiles', () => {
    for (const profile of [posthogProfile, genericProfile]) {
      const r = check(filter('gift_wrapped', 'exact', ['true']), context([shop()], profile));
      expect(r).toMatchObject({ effect: 'unknown', reasons: [VALUE_NOT_COMPARABLE] });
      expect(value(r)?.unreachable).toEqual([]);
      expect(value(r)?.finding).toBeUndefined();
    }
    const both = check(filter('gift_wrapped', 'exact', ['true', 'false']));
    expect(both.effect).toBe('unknown');
  });

  it('other type mismatches and null are unknown', () => {
    expect(check(filter('quantity', 'exact', ['1'])).effect).toBe('unknown');
    expect(check(filter('format', 'exact', [0])).effect).toBe('unknown');
    expect(check(filter('format', 'exact', [null])).effect).toBe('unknown');
  });

  it('a same-type mismatch counts: boolean and number in posthog, unknown in generic', () => {
    const ctx = context([
      shop({
        events: {
          order_completed: event(30, { gift_wrapped: finite([false]), quantity: finite([1, 2]) }),
        },
      }),
    ]);
    expect(check(filter('gift_wrapped', 'exact', [true]), ctx).effect).toBe('dead');
    expect(check(filter('gift_wrapped', 'exact', [false]), ctx).effect).toBe('live');
    expect(check(filter('quantity', 'exact', [3]), ctx).effect).toBe('dead');
    expect(check(filter('quantity', 'exact', [2, 3]), ctx).effect).toBe('degraded');
    const generic = context([shop()], genericProfile);
    expect(check(filter('quantity', 'exact', [3]), generic)).toMatchObject({
      effect: 'unknown',
      reasons: [VALUE_NOT_COMPARABLE],
    });
    expect(check(filter('format', 'exact', ['audiobook']), generic).effect).toBe('dead');
  });

  it('an unreachable value next to an undecided one: degraded, with the reason', () => {
    const r = check(filter('format', 'exact', ['audiobook', 0]));
    expect(r.effect).toBe('degraded');
    expect(value(r)).toMatchObject({
      effect: 'degraded',
      unreachable: ['audiobook'],
      reasons: [VALUE_NOT_COMPARABLE],
    });
  });

  it('a reachable value next to an undecided one: unknown', () => {
    const r = check(filter('format', 'exact', ['ebook', 0]));
    expect(r).toMatchObject({ effect: 'unknown', reasons: [VALUE_NOT_COMPARABLE] });
  });

  it('no values: unknown', () => {
    expect(check(filter('format', 'exact', []))).toMatchObject({
      effect: 'unknown',
      reasons: [NO_VALUES],
    });
  });
});

describe('value-is-reachable: is_not', () => {
  it('values the code sends: live', () => {
    expect(check(filter('format', 'is_not', ['ebook'])).effect).toBe('live');
  });

  it('a value the code never sends excludes nothing: degraded, never dead', () => {
    const all = check(filter('format', 'is_not', ['audiobook']));
    expect(all.effect).toBe('degraded');
    expect(value(all)?.finding).toMatchObject({
      check: 'value-is-reachable',
      effect: 'degraded',
      detail: { op: 'is_not', unreachable: ['audiobook'] },
    });
    expect(check(filter('format', 'is_not', ['audiobook', 'ebook'])).effect).toBe('degraded');
  });

  it('a type mismatch is unknown', () => {
    expect(check(filter('gift_wrapped', 'is_not', ['true'])).effect).toBe('unknown');
  });
});

describe('value-is-reachable: icontains', () => {
  it('a substring of a value the code sends, ignoring ASCII case: live', () => {
    expect(check(filter('format', 'icontains', ['book'])).effect).toBe('live');
    expect(check(filter('format', 'icontains', ['PAPER'])).effect).toBe('live');
  });

  it('a substring of no value: dead', () => {
    const r = check(filter('format', 'icontains', ['audio']));
    expect(r.effect).toBe('dead');
    expect(value(r)?.finding?.detail).toMatchObject({ op: 'icontains', unreachable: ['audio'] });
  });

  it('a non-string value or several values: unknown', () => {
    expect(check(filter('quantity', 'icontains', [1]))).toMatchObject({
      effect: 'unknown',
      reasons: [VALUE_NOT_COMPARABLE],
    });
    expect(check(filter('format', 'icontains', ['audio', 'book']))).toMatchObject({
      effect: 'unknown',
      reasons: [SEVERAL_CONTAINS_VALUES],
    });
  });
});

describe('value-is-reachable: when it applies', () => {
  it('regex and not_regex on a finite domain: unknown (spec 6.6 row 6)', () => {
    for (const op of ['regex', 'not_regex'])
      expect(check(filter('format', op, ['^audio']))).toMatchObject({
        effect: 'unknown',
        reasons: [REGEX_VALUES],
      });
  });

  it('other operators are not value-checked', () => {
    for (const op of ['gt', 'is_set', 'not_icontains', 'semver_eq']) {
      const r = check(filter('format', op, ['zzz']));
      expect(r.effect).toBe('live');
      expect(value(r)).toBeUndefined();
    }
  });

  it('an open domain is not value-checked', () => {
    const r = check(filter('coupon', 'exact', ['anything']));
    expect(r.effect).toBe('live');
    expect(value(r)).toBeUndefined();
  });

  it('a person-scope property has no code values: not value-checked', () => {
    const r = check(filter('favourite_genre', 'exact', ['nothing-sends-this'], 'person'));
    expect(r.effect).toBe('live');
    expect(value(r)).toBeUndefined();
  });

  it('a property only PostHog saw has no code values: not value-checked', () => {
    const observed: Observed = {
      windowDays: 30,
      events: { order_completed: { defined: true, lastSeenAt: RECENT } },
      eventProperties: { order_completed: { seen: ['shelf'], notSeen: [] } },
    };
    const r = check(filter('shelf', 'exact', ['top']), context([shop()], posthogProfile, observed));
    expect(r.effect).toBe('live');
    expect(value(r)).toBeUndefined();
  });

  it('a never-sent property stays with property-is-sent', () => {
    const r = check(filter('binding', 'exact', ['cloth']));
    expect(r.effect).toBe('dead');
    expect(value(r)).toBeUndefined();
    expect(r.checks[0]?.finding?.check).toBe('property-is-sent');
  });

  it('the finding carries the observed fact when there is observed data', () => {
    const observed: Observed = {
      windowDays: 30,
      events: { order_completed: { defined: true, lastSeenAt: RECENT } },
      eventProperties: { order_completed: { seen: ['format'], notSeen: [] } },
    };
    const r = check(
      filter('format', 'exact', ['audiobook']),
      context([shop()], posthogProfile, observed),
    );
    expect(value(r)?.finding?.observed).toBe('seen');
  });
});

describe('value-is-reachable: complete domains only', () => {
  it('another site with open properties: an unreachable value is unknown, a reachable one live', () => {
    const closed = event(30, { format: finite(['ebook', 'paperback']) });
    const order_completed: CatalogEvent = {
      ...closed,
      sites: [...closed.sites, ...event(31, {}, true).sites],
      openSites: 1,
    };
    const ctx = context([shop({ events: { ...BOOKSHOP, order_completed } })]);
    expect(check(filter('format', 'exact', ['audiobook']), ctx)).toMatchObject({
      effect: 'unknown',
      reasons: ['open-properties'],
    });
    expect(check(filter('format', 'exact', ['ebook']), ctx).effect).toBe('live');
    expect(check(filter('format', 'is_not', ['audiobook']), ctx).effect).toBe('unknown');
  });

  it('an open super property call: unknown with its reason', () => {
    const ctx = context([shop({ openSuperSites: 1 })]);
    expect(check(filter('format', 'exact', ['audiobook']), ctx)).toMatchObject({
      effect: 'unknown',
      reasons: ['open-super-properties'],
    });
  });

  it('super property values count as sent', () => {
    const ctx = context([
      shop({
        superProperties: {
          store: {
            ...finite(['online'], 'sometimes'),
            sites: [{ file: 'src/boot.ts', line: 3, call: 'register' }],
          },
        },
      }),
    ]);
    expect(check(filter('store', 'exact', ['online']), ctx).effect).toBe('live');
    expect(check(filter('store', 'exact', ['kiosk']), ctx).effect).toBe('dead');
  });

  it('values are merged across sources', () => {
    const ctx = context([
      shop({ events: { order_completed: event(30, { format: finite(['paperback']) }) } }),
      shop({ name: 'app', events: { order_completed: event(12, { format: finite(['ebook']) }) } }),
    ]);
    expect(check(filter('format', 'exact', ['ebook']), ctx).effect).toBe('live');
    expect(check(filter('format', 'exact', ['paperback', 'ebook']), ctx).effect).toBe('live');
    expect(check(filter('format', 'exact', ['audiobook']), ctx).effect).toBe('dead');
  });
});

describe('value-is-reachable inside an any filter (OR)', () => {
  const any = (...members: PropertyFilter[]) => ({ any: members });

  it('an unreachable member next to a live one: live, its finding becomes info', () => {
    const r = checkFilter(
      context(),
      'order_completed',
      any(filter('format', 'exact', ['audiobook']), filter('format', 'exact', ['ebook'])),
      'f',
    );
    expect(r.effect).toBe('live');
    expect(r.checks[0]?.value?.finding).toMatchObject({ path: 'f.any[0]', effect: 'info' });
    expect(r.checks[1]?.value?.finding).toBeUndefined();
  });

  it('every member unreachable: dead, the findings stay dead', () => {
    const r = checkFilter(
      context(),
      'order_completed',
      any(filter('format', 'exact', ['audiobook']), filter('format', 'icontains', ['audio'])),
      'f',
    );
    expect(r.effect).toBe('dead');
    expect(r.checks.map((c) => c.value?.finding?.effect)).toEqual(['dead', 'dead']);
  });

  it('an undecided member next to an unreachable one: unknown with the reason', () => {
    const r = checkFilter(
      context(),
      'order_completed',
      any(filter('format', 'exact', ['audiobook']), filter('gift_wrapped', 'exact', ['true'])),
      'f',
    );
    expect(r).toMatchObject({ effect: 'unknown', reasons: [VALUE_NOT_COMPARABLE] });
    expect(r.checks[0]?.value?.finding?.effect).toBe('info');
  });
});

describe('the merge marks a domain that may be incomplete', () => {
  it('closed: no incomplete reasons; open site: open-properties', () => {
    const closed = mergeCatalogs([shop()], new Map());
    expect(propertyFact(closed, 'order_completed', 'format').incomplete).toBeUndefined();
    const open = mergeCatalogs([shop({ openSuperSites: 2 })], new Map());
    expect(propertyFact(open, 'order_completed', 'format')).toMatchObject({
      fact: 'yes',
      incomplete: ['open-super-properties'],
    });
  });
});
