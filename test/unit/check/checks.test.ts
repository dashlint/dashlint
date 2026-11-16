import { describe, expect, it } from 'vitest';
import {
  ALL_EVENTS,
  NO_LIVE_EVENT,
  OPERATOR_NOT_CHECKED,
  PERSON_MATH_PROPERTY,
  PERSON_NOT_OBSERVED,
  SCOPE_NOT_CHECKED,
  checkBreakdown,
  checkEvent,
  checkFilter,
  checkMathProperty,
  closestName,
  editDistance,
  genericProfile,
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
import type { Observed, PropertyFilter } from '../../../src/formats/requirements.js';
import { validateCatalog } from '../../../src/formats/validate.js';

const PULLED = '2026-12-18T09:12:00Z';
const RECENT = '2026-12-17T08:00:00Z';

const always = (set: string[]): PropertyFact => ({
  presence: 'always',
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

interface Shop {
  events?: Record<string, CatalogEvent>;
  superProperties?: Catalog['superProperties'];
  personProperties?: string[];
  openSites?: number;
}

/** The invented bookshop (spec 6.17): one closed web source. */
function shop(parts: Shop = {}): Catalog {
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
    events: parts.events ?? {
      wishlist_shared: event(41, { genre_id: always(['fiction', 'poetry']) }),
      order_completed: event(30, { format: always(['paperback', 'ebook']) }),
      giftcard_redeemed: event(88, {}),
    },
    superProperties: parts.superProperties ?? {},
    personProperties: Object.fromEntries(
      (parts.personProperties ?? ['favourite_genre']).map((k) => [
        k,
        { sites: [{ file: 'src/account.ts', line: 7, call: 'people.set' }] },
      ]),
    ),
    builtins: { events: [], properties: null, conditional: [], off: [] },
    identity: [],
    coverage: {
      files: 3,
      excludedFiles: 0,
      oversizeFiles: 0,
      crashedFiles: 0,
      callSites: 10,
      literalNameSites: 10 - (parts.openSites ?? 0),
      openSites: parts.openSites ?? 0,
      nameResolutionRate: (10 - (parts.openSites ?? 0)) / 10,
      openSuperSites: 0,
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
  observed?: Observed,
  profile: RulesProfile = posthogProfile,
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

function filter(key: string, op = 'exact', values: PropertyFilter['values'] = ['Fiction']) {
  return { key, scope: 'event' as const, op, values };
}

describe('closest-name hint (spec 6.9.7)', () => {
  it('edit distance', () => {
    expect(editDistance('genre', 'genre')).toBe(0);
    expect(editDistance('genre', 'genre_id')).toBe(3);
    expect(editDistance('gift_card_redeemed', 'giftcard_redeemed')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
  });

  it('picks the smallest distance up to 3, ties by code point', () => {
    expect(closestName('gift_card_redeemed', ['order_completed', 'giftcard_redeemed'])).toBe(
      'giftcard_redeemed',
    );
    expect(closestName('genre', ['genre_id', 'genres'])).toBe('genres');
    expect(closestName('formats', ['format_', 'formatx'])).toBe('format_');
    expect(closestName('formats', ['formatx', 'format_'])).toBe('format_');
  });

  it('falls back to the longest shared prefix of at least 4 characters', () => {
    expect(closestName('checkout_paid_by_card', ['checkout_started', 'checkout_paid'])).toBe(
      'checkout_paid',
    );
    expect(closestName('checkout_paid_by_card', ['check_in', 'cart_viewed'])).toBe('check_in');
    expect(closestName('order_refunded_in_full', ['ord', 'basket_emptied'])).toBe('ord');
    expect(closestName('checkout_paid_by_card', ['che_x', 'basket_emptied'])).toBeUndefined();
  });

  it('gives no hint for itself, an empty name, a far name or a full replacement', () => {
    expect(closestName('genre', ['genre'])).toBeUndefined();
    expect(closestName('genre', [''])).toBeUndefined();
    expect(closestName('wishlist_shared', ['order_completed'])).toBeUndefined();
    expect(closestName('ab', ['cd'])).toBeUndefined();
    expect(closestName('ab', ['ac'])).toBe('ac');
    // distance 4 and no shared prefix: too far
    expect(closestName('abcdef', ['wxyzef'])).toBeUndefined();
    expect(closestName('abcdef', ['wxydef'])).toBe('wxydef');
  });
});

describe('event-has-call-site', () => {
  it('an event a call site sends is live, with no finding', () => {
    const r = checkEvent(context(), 'wishlist_shared', 'series[0]');
    expect(r).toMatchObject({ effect: 'live', event: 'wishlist_shared' });
    expect(r.finding).toBeUndefined();
  });

  it('no code sends it (code only): dead, with the closest event and its sites', () => {
    const r = checkEvent(context(), 'gift_card_redeemed', 'series[1]');
    expect(r.effect).toBe('dead');
    expect(r.finding).toEqual({
      check: 'event-has-call-site',
      path: 'series[1]',
      effect: 'dead',
      event: 'gift_card_redeemed',
      code: 'no',
      sites: [{ file: 'web/src/shop88.ts', line: 88 }],
      hint: { closestEvent: 'giftcard_redeemed' },
      detail: { basis: 'code-only' },
    });
  });

  it('no code sends it and PostHog never saw it: dead with high confidence', () => {
    const r = checkEvent(
      context([shop()], { windowDays: 30, events: { book_reviewed: { defined: false } } }),
      'book_reviewed',
      'series[0]',
    );
    expect(r.finding).toMatchObject({
      effect: 'dead',
      code: 'no',
      observed: 'notSeen',
      sites: [],
      detail: { basis: 'high' },
    });
    expect(r.finding?.hint).toBeUndefined();
  });

  it('PostHog sees what no code sends: live with an info finding', () => {
    const r = checkEvent(
      context([shop()], {
        windowDays: 30,
        events: { book_reviewed: { defined: true, lastSeenAt: RECENT } },
      }),
      'book_reviewed',
      'series[0]',
    );
    expect(r.effect).toBe('live');
    expect(r.finding).toMatchObject({
      effect: 'info',
      code: 'no',
      observed: 'seen',
      detail: { producedElsewhere: true },
    });
  });

  it('an open event name makes a missing event unknown, never dead', () => {
    const r = checkEvent(context([shop({ openSites: 1 })]), 'book_reviewed', 'series[0]');
    expect(r).toMatchObject({ effect: 'unknown', reasons: ['open-event-name'] });
    expect(r.finding).toBeUndefined();
  });
});

describe('property-is-sent: filters', () => {
  it('a positive filter on a key no call site sends: dead, closest key, event sites', () => {
    const r = checkFilter(context(), 'wishlist_shared', filter('genre'), 'series[0].filters[0]');
    expect(r.effect).toBe('dead');
    expect(r.checks[0]).toMatchObject({ sent: 'no', role: 'filter', op: 'exact' });
    expect(r.checks[0]?.finding).toEqual({
      check: 'property-is-sent',
      path: 'series[0].filters[0]',
      effect: 'dead',
      event: 'wishlist_shared',
      property: 'genre',
      values: ['Fiction'],
      code: 'no',
      sites: [{ file: 'web/src/shop41.ts', line: 41 }],
      hint: { closestProperty: 'genre_id' },
      detail: { role: 'filter', scope: 'event', op: 'exact', basis: 'code-only' },
    });
  });

  it('a positive filter on a key the code sends is live, with no finding', () => {
    const r = checkFilter(
      context(),
      'wishlist_shared',
      filter('genre_id', 'exact', ['fiction']),
      'f',
    );
    expect(r).toMatchObject({ effect: 'live' });
    expect(r.checks[0]).toMatchObject({ sent: 'yes', presence: 'always' });
    expect(r.checks[0]?.property?.values).toEqual({ kind: 'finite', set: ['fiction', 'poetry'] });
    expect(r.checks[0]?.finding).toBeUndefined();
  });

  it('a negative filter on a never-sent key has no effect: degraded', () => {
    const r = checkFilter(context(), 'wishlist_shared', filter('genre', 'is_not'), 'f');
    expect(r.effect).toBe('degraded');
    expect(r.checks[0]?.finding?.effect).toBe('degraded');
  });

  it('semver_neq drops events lacking the key in PostHog: dead', () => {
    const r = checkFilter(context(), 'wishlist_shared', filter('app_version', 'semver_neq'), 'f');
    expect(r.effect).toBe('dead');
  });

  it('an operator the profile does not list is unknown, even on a never-sent key', () => {
    const r = checkFilter(context(), 'wishlist_shared', filter('genre', 'in'), 'f');
    expect(r).toMatchObject({ effect: 'unknown', reasons: [OPERATOR_NOT_CHECKED] });
    expect(r.checks[0]).toMatchObject({ sent: 'no' });
    expect(r.checks[0]?.finding).toBeUndefined();
  });

  it('open properties at a site make a missing key unknown, never dead', () => {
    const c = shop({ events: { wishlist_shared: event(41, {}, true) } });
    const r = checkFilter(context([c]), 'wishlist_shared', filter('genre'), 'f');
    expect(r).toMatchObject({ effect: 'unknown', reasons: ['open-properties'] });
  });

  it('a filter on an event no code sends is unknown (the event check decides)', () => {
    const r = checkFilter(context(), 'book_reviewed', filter('genre'), 'f');
    expect(r).toMatchObject({ effect: 'unknown', reasons: ['event-not-sent'] });
  });

  it('scopes outside event and person are not checked', () => {
    const r = checkFilter(
      context(),
      'wishlist_shared',
      { key: '$session_duration', scope: 'session', op: 'gt', values: [10] },
      'f',
    );
    expect(r).toMatchObject({ effect: 'unknown', reasons: [SCOPE_NOT_CHECKED] });
    expect(r.checks[0]).toMatchObject({ sent: 'unknown' });
  });

  it('an event-scope filter on every event is not decided by one event', () => {
    const r = checkFilter(context(), null, filter('genre'), 'f');
    expect(r).toMatchObject({ effect: 'unknown', reasons: [ALL_EVENTS] });
  });

  it('PostHog saw the key on the event although no code sends it: live with info', () => {
    const o: Observed = {
      windowDays: 30,
      events: { wishlist_shared: { defined: true, lastSeenAt: RECENT } },
      eventProperties: { wishlist_shared: { seen: ['genre'], notSeen: [] } },
    };
    const r = checkFilter(context([shop()], o), 'wishlist_shared', filter('genre'), 'f');
    expect(r.effect).toBe('live');
    expect(r.checks[0]?.finding).toMatchObject({
      effect: 'info',
      observed: 'seen',
      detail: { producedElsewhere: true },
    });
  });

  it('code and PostHog both say no: dead with high confidence, observed notSeen', () => {
    const o: Observed = {
      windowDays: 30,
      events: { wishlist_shared: { defined: true, lastSeenAt: RECENT } },
      eventProperties: { wishlist_shared: { seen: ['genre_id'], notSeen: ['genre'] } },
    };
    const r = checkFilter(context([shop()], o), 'wishlist_shared', filter('genre'), 'f');
    expect(r.checks[0]?.finding).toMatchObject({
      effect: 'dead',
      observed: 'notSeen',
      detail: { basis: 'high' },
    });
  });

  it('code unknown, the event arrives without the key: dead on observed data', () => {
    const c = shop({ events: { wishlist_shared: event(41, {}, true) } });
    const o: Observed = {
      windowDays: 30,
      events: { wishlist_shared: { defined: true, lastSeenAt: RECENT } },
      eventProperties: { wishlist_shared: { seen: [], notSeen: ['genre'] } },
    };
    const r = checkFilter(context([c], o), 'wishlist_shared', filter('genre'), 'f');
    expect(r.effect).toBe('dead');
    expect(r.checks[0]?.finding).toMatchObject({ code: 'unknown', detail: { basis: 'observed' } });
  });

  // The spec's negative control: a key sent only as a super property is sent "sometimes".
  it('negative control: a key sent only as a super property counts as sent sometimes', () => {
    const c = shop({
      superProperties: {
        shop_tier: {
          presence: 'always',
          values: { kind: 'finite', set: ['free', 'member'] },
          sites: [{ file: 'src/boot.ts', line: 2, call: 'register' }],
        },
      },
    });
    const r = checkFilter(
      context([c]),
      'order_completed',
      filter('shop_tier', 'exact', ['member']),
      'f',
    );
    expect(r.effect).toBe('live');
    expect(r.checks[0]).toMatchObject({ sent: 'yes', presence: 'sometimes' });
    expect(r.checks[0]?.finding).toBeUndefined();
    const b = checkBreakdown(
      context([c]),
      { key: 'shop_tier', scope: 'event' },
      ['order_completed'],
      'breakdown[0]',
    );
    expect(b.effect).toBe('live');
    expect(b.finding).toMatchObject({ effect: 'info', detail: { presence: 'sometimes' } });
  });
});

describe('property-is-sent: person scope', () => {
  const person = (key: string, op = 'exact') => ({
    key,
    scope: 'person' as const,
    op,
    values: ['x'],
  });

  it('a person property the code sets is live', () => {
    expect(checkFilter(context(), 'order_completed', person('favourite_genre'), 'f').effect).toBe(
      'live',
    );
  });

  it('never set, code only: dead, closest person property, no sites', () => {
    const r = checkFilter(context(), 'order_completed', person('favourite_genres'), 'f');
    expect(r.effect).toBe('dead');
    expect(r.checks[0]?.finding).toMatchObject({
      property: 'favourite_genres',
      sites: [],
      hint: { closestProperty: 'favourite_genre' },
      detail: { scope: 'person', basis: 'code-only' },
    });
  });

  it('posthog profile with observed data that does not list it: unknown', () => {
    const o: Observed = { windowDays: 30, events: {}, personProperties: { seen: [], notSeen: [] } };
    const r = checkFilter(context([shop()], o), 'order_completed', person('reading_goal'), 'f');
    expect(r).toMatchObject({ effect: 'unknown', reasons: [PERSON_NOT_OBSERVED] });
  });

  it('generic profile: dead from code alone, observed data or not', () => {
    const o: Observed = { windowDays: 30, events: {} };
    const r = checkFilter(
      context([shop()], o, genericProfile),
      'order_completed',
      person('reading_goal'),
      'f',
    );
    expect(r.effect).toBe('dead');
  });

  it('PostHog lists it as never seen: dead with high confidence', () => {
    const o: Observed = {
      windowDays: 30,
      events: {},
      personProperties: { seen: [], notSeen: ['reading_goal'] },
    };
    const r = checkFilter(context([shop()], o), 'order_completed', person('reading_goal'), 'f');
    expect(r.checks[0]?.finding).toMatchObject({ effect: 'dead', detail: { basis: 'high' } });
  });

  it('a person filter on every event is still decided', () => {
    expect(checkFilter(context(), null, person('reading_goal'), 'f').effect).toBe('dead');
  });
});

describe('property-is-sent: any filters (OR)', () => {
  const any = (...members: PropertyFilter[]) => ({ any: members });

  it('every member drops every event: dead, member findings dead', () => {
    const r = checkFilter(context(), 'wishlist_shared', any(filter('genre'), filter('shelf')), 'f');
    expect(r.effect).toBe('dead');
    expect(r.checks.map((c) => c.finding?.path)).toEqual(['f.any[0]', 'f.any[1]']);
    expect(r.checks.map((c) => c.finding?.effect)).toEqual(['dead', 'dead']);
  });

  it('one live member: live, the dead member becomes an info finding', () => {
    const r = checkFilter(
      context(),
      'wishlist_shared',
      any(filter('genre'), filter('genre_id', 'exact', ['fiction'])),
      'f',
    );
    expect(r.effect).toBe('live');
    expect(r.checks[0]?.finding?.effect).toBe('info');
    expect(r.reasons).toBeUndefined();
  });

  it('one member that keeps every event: degraded', () => {
    const r = checkFilter(
      context(),
      'wishlist_shared',
      any(filter('genre'), filter('shelf', 'is_not'), filter('genre_id')),
      'f',
    );
    expect(r.effect).toBe('degraded');
    expect(r.checks.map((c) => c.finding?.effect)).toEqual(['info', 'degraded', undefined]);
  });

  it('dead and unknown members: unknown with the reasons', () => {
    const r = checkFilter(
      context(),
      'wishlist_shared',
      any(filter('genre'), filter('shelf', 'in')),
      'f',
    );
    expect(r).toMatchObject({ effect: 'unknown', reasons: [OPERATOR_NOT_CHECKED] });
  });

  it('an empty any is unknown', () => {
    expect(checkFilter(context(), 'wishlist_shared', any(), 'f')).toMatchObject({
      effect: 'unknown',
      reasons: [],
    });
  });
});

describe('property-is-sent: math properties', () => {
  it('an event-scope math property never sent: dead', () => {
    const r = checkMathProperty(
      context(),
      'order_completed',
      { key: 'price', scope: 'event' },
      'series[0].mathProperty',
    );
    expect(r).toMatchObject({ effect: 'dead', role: 'math-property', sent: 'no' });
    expect(r.finding).toMatchObject({ effect: 'dead', detail: { role: 'math-property' } });
    expect(r.finding?.values).toBeUndefined();
  });

  it('a math property the code sends: live', () => {
    expect(
      checkMathProperty(context(), 'order_completed', { key: 'format', scope: 'event' }, 'm')
        .effect,
    ).toBe('live');
  });

  it('a person-scope math property never set is unknown (6.7.3 names event scope only)', () => {
    const r = checkMathProperty(
      context(),
      'order_completed',
      { key: 'lifetime_spend', scope: 'person' },
      'm',
    );
    expect(r).toMatchObject({ effect: 'unknown', sent: 'no', reasons: [PERSON_MATH_PROPERTY] });
  });
});

describe('property-is-sent: breakdowns', () => {
  const format = { key: 'format', scope: 'event' as const };

  it('one event that never sends the key: degraded, closest key, event sites', () => {
    const r = checkBreakdown(
      context(),
      { key: 'genre', scope: 'event' },
      ['wishlist_shared'],
      'breakdown[0]',
    );
    expect(r.effect).toBe('degraded');
    expect(r.finding).toMatchObject({
      check: 'property-is-sent',
      effect: 'degraded',
      event: 'wishlist_shared',
      sites: [{ file: 'web/src/shop41.ts', line: 41 }],
      hint: { closestProperty: 'genre_id' },
      detail: { role: 'breakdown' },
    });
  });

  it('no event sends it: degraded, one finding naming every event', () => {
    const r = checkBreakdown(
      context(),
      { key: 'formats', scope: 'event' },
      ['wishlist_shared', 'giftcard_redeemed'],
      'b',
    );
    expect(r.effect).toBe('degraded');
    expect(r.finding?.event).toBeUndefined();
    expect(r.finding).toMatchObject({
      sites: [
        { file: 'web/src/shop41.ts', line: 41 },
        { file: 'web/src/shop88.ts', line: 88 },
      ],
      detail: { missingOn: ['wishlist_shared', 'giftcard_redeemed'] },
    });
    expect(r.finding?.hint).toBeUndefined();
    expect(Object.keys(r.finding ?? {})).not.toContain('observed');
    expect(Object.keys(r.finding ?? {})).not.toContain('hint');
  });

  it('no event sends it, a close key exists: the merged finding keeps the hint and observed', () => {
    const o: Observed = {
      windowDays: 30,
      events: {
        wishlist_shared: { defined: true, lastSeenAt: RECENT },
        giftcard_redeemed: { defined: true, lastSeenAt: RECENT },
      },
      eventProperties: {
        wishlist_shared: { seen: ['genre_id'], notSeen: ['genre'] },
        giftcard_redeemed: { seen: [], notSeen: ['genre'] },
      },
    };
    const r = checkBreakdown(
      context([shop()], o),
      { key: 'genre', scope: 'event' },
      ['wishlist_shared', 'giftcard_redeemed'],
      'b',
    );
    expect(r.effect).toBe('degraded');
    expect(r.finding).toMatchObject({
      check: 'property-is-sent',
      path: 'b',
      effect: 'degraded',
      property: 'genre',
      observed: 'notSeen',
      hint: { closestProperty: 'genre_id' },
      detail: { role: 'breakdown', missingOn: ['wishlist_shared', 'giftcard_redeemed'] },
    });
  });

  it('two events send it, one only sometimes: info with presence, no event, no missingOn', () => {
    const c = shop({
      events: {
        order_completed: event(30, { format: always(['paperback']) }),
        wishlist_shared: event(41, {
          format: { presence: 'sometimes', values: always(['ebook']).values },
        }),
      },
    });
    const r = checkBreakdown(context([c]), format, ['order_completed', 'wishlist_shared'], 'b');
    expect(r.effect).toBe('live');
    expect(r.finding).toEqual({
      check: 'property-is-sent',
      path: 'b',
      effect: 'info',
      property: 'format',
      code: 'yes',
      sites: [],
      detail: { role: 'breakdown', scope: 'event', presence: 'sometimes' },
    });
  });

  it('one event sends it sometimes and the other is unknown: the info names the sending event', () => {
    const c = shop({
      events: {
        order_completed: event(30, {
          format: { presence: 'sometimes', values: always(['ebook']).values },
        }),
        giftcard_redeemed: event(88, {}, true),
      },
    });
    const r = checkBreakdown(context([c]), format, ['order_completed', 'giftcard_redeemed'], 'b');
    expect(r.effect).toBe('live');
    expect(r.checks.map((x) => x.sent)).toEqual(['yes', 'unknown']);
    expect(r.finding).toMatchObject({ effect: 'info', event: 'order_completed' });
    expect(Object.keys(r.finding?.detail ?? {})).not.toContain('missingOn');
  });

  it('two events from one call site (a literal union) list the site once', () => {
    const c = shop({ events: { shelf_opened: event(12, {}), shelf_closed: event(12, {}) } });
    const r = checkBreakdown(
      context([c]),
      { key: 'shelf', scope: 'event' },
      ['shelf_opened', 'shelf_closed'],
      'b',
    );
    expect(r.finding?.sites).toEqual([{ file: 'web/src/shop12.ts', line: 12 }]);
  });

  it('some events send it: live with an info finding naming the others', () => {
    const r = checkBreakdown(
      context(),
      format,
      ['order_completed', 'wishlist_shared', 'order_completed'],
      'b',
    );
    expect(r.effect).toBe('live');
    expect(r.checks).toHaveLength(2);
    expect(r.finding).toMatchObject({
      effect: 'info',
      code: 'yes',
      sites: [{ file: 'web/src/shop41.ts', line: 41 }],
      detail: { missingOn: ['wishlist_shared'] },
    });
    // One event sends it but another does not: the info belongs to no single event.
    expect(Object.keys(r.finding ?? {})).not.toContain('event');
  });

  it('every event always sends it: live, no finding', () => {
    expect(checkBreakdown(context(), format, ['order_completed'], 'b')).toMatchObject({
      effect: 'live',
    });
    expect(checkBreakdown(context(), format, ['order_completed'], 'b').finding).toBeUndefined();
  });

  it('unknown on one event and no on another: unknown, never degraded', () => {
    const c = shop({
      events: {
        wishlist_shared: event(41, {}, true),
        giftcard_redeemed: event(88, {}),
      },
    });
    const r = checkBreakdown(context([c]), format, ['wishlist_shared', 'giftcard_redeemed'], 'b');
    expect(r).toMatchObject({ effect: 'unknown', reasons: ['open-properties'] });
    expect(r.finding).toBeUndefined();
  });

  it('no live event to check: unknown', () => {
    expect(checkBreakdown(context(), format, [], 'b')).toMatchObject({
      effect: 'unknown',
      reasons: [NO_LIVE_EVENT],
    });
  });

  it('a person property never set: degraded, checked once', () => {
    const r = checkBreakdown(
      context(),
      { key: 'reading_goal', scope: 'person' },
      ['order_completed', 'wishlist_shared'],
      'b',
    );
    expect(r.effect).toBe('degraded');
    expect(r.checks).toHaveLength(1);
    expect(r.finding).toMatchObject({ property: 'reading_goal', sites: [] });
  });

  it('a scope outside the profile: unknown', () => {
    const r = checkBreakdown(
      context(),
      { key: '$initial_referrer', scope: 'session' },
      ['order_completed'],
      'b',
    );
    expect(r).toMatchObject({ effect: 'unknown', reasons: [SCOPE_NOT_CHECKED] });
  });
});
