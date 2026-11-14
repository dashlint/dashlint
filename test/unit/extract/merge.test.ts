import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import {
  builtinTables,
  eventFact,
  extractCatalog,
  mergeCatalogs,
  nameResolutionRate,
  personPropertyFact,
  propertyFact,
  type BuiltinTables,
  type ExtractInput,
} from '../../../src/extract/index.js';
import type {
  Catalog,
  CatalogEvent,
  EventSite,
  PropertyFact,
} from '../../../src/formats/catalog.js';
import { validateCatalog } from '../../../src/formats/validate.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));

const always = (set?: (string | boolean)[]): PropertyFact => ({
  presence: 'always',
  values: set ? { kind: 'finite', set } : { kind: 'open', type: 'string' },
});
const sometimes = (set?: (string | boolean)[]): PropertyFact => ({
  ...always(set),
  presence: 'sometimes',
});

function site(file: string, line: number, platforms: string[], openProperties = false): EventSite {
  return { file, line, sdk: 'shop-sdk', via: [], platforms, openProperties };
}

function event(sites: EventSite[], properties: Record<string, PropertyFact> = {}): CatalogEvent {
  return { sites, openSites: sites.filter((s) => s.openProperties).length, properties };
}

/** A small valid catalog of one source; `events` and the rest as given. */
function catalog(
  name: string,
  platforms: string[],
  parts: Partial<Omit<Catalog, 'coverage'>> & { coverage?: Partial<Catalog['coverage']> } = {},
): Catalog {
  const c: Catalog = {
    schema: 'dashlint.catalog/1',
    tool: '0.0.0-test',
    source: {
      name,
      root: name,
      commit: null,
      platforms,
      sdks: [{ id: 'shop-sdk', version: '1.0.0', types: 'stub' }],
    },
    openWorld: [],
    events: {},
    superProperties: {},
    personProperties: {},
    builtins: { events: [], properties: null, conditional: [], off: [] },
    identity: [],
    ...parts,
    coverage: {
      files: 3,
      excludedFiles: 0,
      oversizeFiles: 0,
      crashedFiles: 0,
      callSites: 4,
      literalNameSites: 4,
      openSites: 0,
      nameResolutionRate: 1,
      openSuperSites: 0,
      openPersonSites: 0,
      ...parts.coverage,
    },
  };
  const v = validateCatalog(c);
  if (!v.ok) throw new Error(`invalid test catalog: ${JSON.stringify(v.errors)}`);
  return c;
}

const NO_TABLES: BuiltinTables = new Map();

/** A builtins table for the invented `shop-sdk`: one property on every event, one on one event. */
const TABLES: BuiltinTables = new Map([
  [
    'shop-sdk',
    {
      events: ['$shelf_view', '$till_open'],
      properties: [
        { name: '$aisle', events: '*', presence: 'always' },
        { name: '$till_lane', events: ['$till_open'], presence: 'always' },
        { name: '$coupon_hint', events: '*', presence: 'sometimes' },
        { name: '$cashier', events: '*', presence: 'always' },
      ],
      personProperties: ['$first_aisle', '$loyalty_tier'],
      unknownNames: {
        events: ['$survey_'],
        properties: ['$feature/'],
        personProperties: ['$geo_'],
      },
    },
  ],
]);
const WITH_TABLE = { events: [], properties: 'shop-sdk@1', conditional: [], off: [] };

const web = (parts: Parameters<typeof catalog>[2] = {}) => catalog('web', ['web'], parts);
const mobile = (parts: Parameters<typeof catalog>[2] = {}) =>
  catalog('mobile', ['ios', 'android'], parts);

describe('mergeCatalogs: two catalogs', () => {
  const a = web({
    events: {
      book_shelved: event([site('web/src/shelf.ts', 4, ['web'])], {
        isbn: always(),
        format: always(['paperback', 'hardback']),
        gift: always([true]),
      }),
    },
  });
  const b = mobile({
    events: {
      book_shelved: event(
        [
          site('mobile/src/shelf.ios.ts', 9, ['ios']),
          site('mobile/src/shelf.ts', 2, ['ios', 'android']),
        ],
        { isbn: always(), format: sometimes(['ebook']), gift: always() },
      ),
      cart_viewed: event([site('mobile/src/cart.ts', 7, ['ios', 'android'])], { items: always() }),
    },
  });
  const m = mergeCatalogs([a, b], NO_TABLES);

  it('unions sites by source and platforms of every site', () => {
    const e = m.events.book_shelved;
    expect(e?.senders).toEqual([0, 1]);
    expect(e?.sites.map((s) => [s.source, s.file, s.line])).toEqual([
      [0, 'web/src/shelf.ts', 4],
      [1, 'mobile/src/shelf.ios.ts', 9],
      [1, 'mobile/src/shelf.ts', 2],
    ]);
    expect(e?.platforms).toEqual(['android', 'ios', 'web']);
    expect(m.events.cart_viewed?.platforms).toEqual(['android', 'ios']);
    expect(m.platforms).toEqual(['android', 'ios', 'web']);
    expect(eventFact(m, 'cart_viewed')).toEqual({
      fact: 'yes',
      unknown: [],
      platforms: ['android', 'ios'],
    });
  });

  it('is always only when every site in every catalog sends it always', () => {
    const p = m.events.book_shelved?.properties;
    expect(p?.isbn).toEqual(always());
    // Sometimes in one catalog: sometimes after the merge, values unioned.
    expect(p?.format).toEqual(sometimes(['ebook', 'hardback', 'paperback']));
    // A finite set and an open value of one type: open.
    expect(p?.gift).toEqual({ presence: 'always', values: { kind: 'open', type: 'unknown' } });
  });

  it('is sometimes when one catalog sends the event without the property', () => {
    const c = mobile({
      events: { book_shelved: event([site('mobile/src/shelf.ts', 2, ['ios'])], {}) },
    });
    const merged = mergeCatalogs([a, c], NO_TABLES);
    expect(merged.events.book_shelved?.properties.isbn?.presence).toBe('sometimes');
    expect(propertyFact(merged, 'book_shelved', 'isbn').fact).toBe('yes');
  });

  it('gives "no" for a property no closed catalog sends', () => {
    expect(propertyFact(m, 'book_shelved', 'shelf_row')).toEqual({ fact: 'no', unknown: [] });
    expect(eventFact(m, 'book_burned')).toEqual({ fact: 'no', unknown: [], platforms: [] });
  });

  it('does not change the catalogs it merges', () => {
    const before = JSON.stringify([a, b]);
    const merged = mergeCatalogs([a, b], TABLES);
    merged.events.book_shelved?.sites[0]?.platforms.push('tv');
    expect(JSON.stringify([a, b])).toBe(before);
  });
});

describe('mergeCatalogs: three catalogs', () => {
  const shelved = (file: string, props: Record<string, PropertyFact>, platforms = ['web']) =>
    event([site(file, 1, platforms)], props);
  const a = web({
    events: { book_shelved: shelved('web/a.ts', { isbn: always(), shelf: always() }) },
  });
  const b = catalog('admin', ['web'], {
    events: { book_shelved: shelved('admin/b.ts', { isbn: always(), shelf: always() }) },
  });
  const c = mobile({
    events: {
      book_shelved: shelved('mobile/c.ts', { isbn: always() }, ['ios']),
      cart_viewed: shelved('mobile/c.ts', {}, ['ios']),
    },
  });

  it('is always only when all three send it always', () => {
    const m = mergeCatalogs([a, b, c], NO_TABLES);
    expect(m.events.book_shelved?.properties.isbn?.presence).toBe('always');
    expect(m.events.book_shelved?.properties.shelf?.presence).toBe('sometimes');
    expect(m.events.book_shelved?.senders).toEqual([0, 1, 2]);
    expect(m.events.book_shelved?.platforms).toEqual(['ios', 'web']);
  });

  it('counts only the catalogs that send the event', () => {
    const m = mergeCatalogs([a, b, c], NO_TABLES);
    // cart_viewed is mobile only: web and admin sending book_shelved with `shelf` does not matter.
    expect(m.events.cart_viewed?.senders).toEqual([2]);
    expect(propertyFact(m, 'cart_viewed', 'shelf').fact).toBe('no');
  });

  it('gives the same facts in any catalog order', () => {
    const orders = [
      [a, b, c],
      [c, b, a],
      [b, c, a],
    ];
    const facts = orders.map((o) => {
      const m = mergeCatalogs(o, NO_TABLES);
      return JSON.stringify({
        events: Object.fromEntries(
          Object.entries(m.events).map(([n, e]) => [n, [e.properties, e.platforms, e.openSites]]),
        ),
        shelf: propertyFact(m, 'cart_viewed', 'shelf'),
        burned: eventFact(m, 'book_burned'),
      });
    });
    expect(new Set(facts).size).toBe(1);
  });
});

describe('negative control: an open site keeps "no" unknown', () => {
  const closed = web({
    events: { book_shelved: event([site('web/a.ts', 1, ['web'])], { isbn: always() }) },
  });

  it('an open properties site in one catalog makes a missing property unknown', () => {
    const open = mobile({
      events: { book_shelved: event([site('mobile/a.ts', 3, ['ios'], true)], { isbn: always() }) },
    });
    expect(propertyFact(mergeCatalogs([closed], NO_TABLES), 'book_shelved', 'shelf').fact).toBe(
      'no',
    );
    const m = mergeCatalogs([closed, open], NO_TABLES);
    expect(m.events.book_shelved?.openSites).toBe(1);
    expect(propertyFact(m, 'book_shelved', 'shelf')).toEqual({
      fact: 'unknown',
      unknown: ['open-properties'],
    });
    // A listed property is still "yes".
    expect(propertyFact(m, 'book_shelved', 'isbn').fact).toBe('yes');
    // Whichever catalog comes first, and summed over catalogs.
    expect(
      propertyFact(mergeCatalogs([open, closed], NO_TABLES), 'book_shelved', 'shelf').fact,
    ).toBe('unknown');
    expect(mergeCatalogs([open, closed, open], NO_TABLES).events.book_shelved?.openSites).toBe(2);
  });

  it('an open event-name site in one catalog makes a missing event unknown', () => {
    const open = mobile({
      coverage: { callSites: 4, literalNameSites: 3, openSites: 1, nameResolutionRate: 0.75 },
      openWorld: [
        {
          file: 'mobile/t.ts',
          line: 2,
          kind: 'event-name',
          reason: 'event name has type `string`',
        },
      ],
    });
    expect(eventFact(mergeCatalogs([closed], NO_TABLES), 'book_burned').fact).toBe('no');
    expect(eventFact(mergeCatalogs([closed, open], NO_TABLES), 'book_burned')).toEqual({
      fact: 'unknown',
      unknown: ['open-event-name'],
      platforms: [],
    });
    expect(eventFact(mergeCatalogs([open, closed], NO_TABLES), 'book_shelved').fact).toBe('yes');
  });

  it('an open template site covers only the names it can match (ADR-061)', () => {
    const site = (prefix?: string, suffix?: string) => ({
      file: 'mobile/t.ts',
      line: 2,
      kind: 'event-name' as const,
      reason: 'event name is a template with a part of type `string`',
      ...(prefix !== undefined && { prefix }),
      ...(suffix !== undefined && { suffix }),
    });
    const withSites = (...openWorld: ReturnType<typeof site>[]) =>
      mergeCatalogs(
        [
          closed,
          mobile({
            coverage: {
              callSites: 10,
              literalNameSites: 10 - openWorld.length,
              openSites: openWorld.length,
              nameResolutionRate: nameResolutionRate(10 - openWorld.length, 10),
            },
            openWorld,
          }),
        ],
        NO_TABLES,
      );
    const fact = (m: ReturnType<typeof withSites>, name: string) => eventFact(m, name).fact;
    const prefixed = withSites(site('shared_via_'));
    expect(fact(prefixed, 'shared_via_email')).toBe('unknown');
    expect(eventFact(prefixed, 'shared_via_email').unknown).toEqual(['open-event-name']);
    expect(fact(prefixed, 'book_burned')).toBe('no');
    // An empty part sends the fixed text alone.
    expect(fact(prefixed, 'shared_via_')).toBe('unknown');
    const suffixed = withSites(site(undefined, '_redeemed'));
    expect(fact(suffixed, 'coupon_redeemed')).toBe('unknown');
    expect(fact(suffixed, 'coupon_redeemed_late')).toBe('no');
    const both = withSites(site('gift_', '_wrapped'));
    expect(fact(both, 'gift_book_wrapped')).toBe('unknown');
    expect(fact(both, 'gift_book')).toBe('no');
    expect(fact(both, 'book_wrapped')).toBe('no');
    // Head and tail overlap in a name too short to hold both.
    expect(fact(withSites(site('ab', 'ba')), 'aba')).toBe('no');
    expect(fact(withSites(site('ab', 'ba')), 'abba')).toBe('unknown');
    // Negative control: a plain open site still keeps every "no" unknown.
    expect(fact(withSites(site()), 'book_burned')).toBe('unknown');
    expect(fact(withSites(site('shared_via_'), site()), 'book_burned')).toBe('unknown');
    // Any one matching site is enough.
    expect(fact(withSites(site('shared_via_'), site('book_')), 'book_burned')).toBe('unknown');
  });

  it('a source below 70% name resolution gives no event-level "no" (D9)', () => {
    const low = mobile({
      coverage: { callSites: 100, literalNameSites: 69, openSites: 0, nameResolutionRate: 0.69 },
    });
    const at = mobile({
      coverage: { callSites: 100, literalNameSites: 70, openSites: 0, nameResolutionRate: 0.7 },
    });
    expect(eventFact(mergeCatalogs([closed, low], NO_TABLES), 'book_burned').unknown).toEqual([
      'low-name-resolution',
    ]);
    expect(eventFact(mergeCatalogs([closed, at], NO_TABLES), 'book_burned').fact).toBe('no');
  });

  it('a crashed file in any catalog keeps event and property "no" unknown', () => {
    const crashed = mobile({
      coverage: {
        crashedFiles: 1,
        callSites: 5,
        literalNameSites: 4,
        openSites: 1,
        nameResolutionRate: 0.8,
      },
      openWorld: [{ file: 'mobile/deep.ts', line: 1, kind: 'file-error', reason: 'RangeError' }],
    });
    const m = mergeCatalogs([closed, crashed], NO_TABLES);
    expect(eventFact(m, 'book_burned').unknown).toEqual(['crashed-file', 'open-event-name']);
    // The crashed file is mobile's; the event is web's only, yet the file may hold one of its sites.
    expect(propertyFact(m, 'book_shelved', 'shelf')).toEqual({
      fact: 'unknown',
      unknown: ['crashed-file'],
    });
    expect(personPropertyFact(m, 'loyalty').unknown).toEqual(['crashed-file']);
    // file-error entries are kept, with their source.
    expect(m.openWorld).toEqual([
      { file: 'mobile/deep.ts', line: 1, kind: 'file-error', reason: 'RangeError', source: 1 },
    ]);
  });
});

describe('super properties are applied per source before the merge', () => {
  const register = (name: string, set: string[]) => ({
    [name]: { ...sometimes(set), sites: [{ file: 'web/main.ts', line: 1, call: 'register' }] },
  });
  const a = web({
    events: {
      book_shelved: event([site('web/a.ts', 1, ['web'])], { storefront: always(['kiosk']) }),
      cart_viewed: event([site('web/a.ts', 2, ['web'])]),
    },
    superProperties: register('storefront', ['web']),
  });
  const b = mobile({
    events: {
      cart_viewed: event([site('mobile/a.ts', 1, ['ios'])]),
      gift_wrapped: event([site('mobile/a.ts', 2, ['ios'])]),
    },
  });
  const m = mergeCatalogs([a, b], NO_TABLES);

  it('a super property reaches its own source events only', () => {
    expect(m.events.gift_wrapped?.properties.storefront).toBeUndefined();
    expect(propertyFact(m, 'gift_wrapped', 'storefront').fact).toBe('no');
    // Sent by web as a super property, not by mobile: sometimes.
    expect(m.events.cart_viewed?.properties.storefront).toEqual(sometimes(['web']));
    // A super property alone is sometimes (spec 6.4 item 7), even in one catalog.
    expect(mergeCatalogs([a], NO_TABLES).events.cart_viewed?.properties.storefront).toEqual(
      sometimes(['web']),
    );
  });

  it('a property sent always and also registered stays always, values unioned', () => {
    expect(m.events.book_shelved?.properties.storefront).toEqual(always(['kiosk', 'web']));
  });

  it('an open super call keeps "no" unknown on that source events only', () => {
    const open = web({ ...a, coverage: { openSuperSites: 1 } });
    const merged = mergeCatalogs([open, b], NO_TABLES);
    expect(propertyFact(merged, 'book_shelved', 'shelf').unknown).toEqual([
      'open-super-properties',
    ]);
    expect(propertyFact(merged, 'cart_viewed', 'shelf').unknown).toEqual(['open-super-properties']);
    expect(propertyFact(merged, 'gift_wrapped', 'shelf').fact).toBe('no');
  });
});

describe('builtins in the merge', () => {
  it('a builtin event is sent on its source platforms, with the table rows that apply', () => {
    const a = web({ builtins: { ...WITH_TABLE, events: ['$shelf_view'] } });
    const b = mobile({ events: { $shelf_view: event([site('mobile/a.ts', 1, ['ios'])]) } });
    const m = mergeCatalogs([a, b], TABLES);
    expect(eventFact(m, '$shelf_view')).toEqual({
      fact: 'yes',
      unknown: [],
      platforms: ['ios', 'web'],
    });
    // web's table sends $aisle always; mobile has no table: sometimes across both.
    expect(m.events.$shelf_view?.properties.$aisle?.presence).toBe('sometimes');
    expect(m.events.$shelf_view?.properties.$till_lane).toBeUndefined();
    expect(propertyFact(mergeCatalogs([a], TABLES), '$shelf_view', '$aisle').property).toEqual({
      presence: 'always',
      values: { kind: 'open', type: 'unknown' },
    });
  });

  it('table rows reach every event of the source, by the SDK of its sites', () => {
    const a = web({
      events: {
        book_shelved: event([site('web/a.ts', 1, ['web'])], { $coupon_hint: always(['x']) }),
      },
      builtins: { ...WITH_TABLE, events: ['$till_open'] },
    });
    const m = mergeCatalogs([a], TABLES);
    const p = m.events.book_shelved?.properties;
    expect(p?.$aisle?.presence).toBe('always');
    // Sent always by the code and sometimes by the table: always; values of both.
    expect(p?.$coupon_hint).toEqual({
      presence: 'always',
      values: { kind: 'open', type: 'unknown' },
    });
    expect(p?.$till_lane).toBeUndefined();
    expect(m.events.$till_open?.properties.$till_lane?.presence).toBe('always');
  });

  it('a catalog that names no table gets no table rows, whatever its sites SDK', () => {
    const a = web({ events: { book_shelved: event([site('web/a.ts', 1, ['web'])]) } });
    const m = mergeCatalogs([a], TABLES);
    expect(m.events.book_shelved?.properties).toEqual({});
    expect(propertyFact(m, 'book_shelved', '$aisle').fact).toBe('no');
    expect(personPropertyFact(m, '$first_aisle').fact).toBe('no');
  });

  it('a builtin event that also has a call site: the code properties become sometimes', () => {
    const a = web({
      events: { $shelf_view: event([site('web/a.ts', 1, ['web'])], { shelf: always() }) },
      builtins: { ...WITH_TABLE, events: ['$shelf_view'] },
    });
    const m = mergeCatalogs([a], TABLES);
    expect(m.events.$shelf_view?.properties.shelf?.presence).toBe('sometimes');
    expect(m.events.$shelf_view?.properties.$aisle?.presence).toBe('always');
  });

  it('names turned off are not sent; undecided ones are unknown', () => {
    const a = web({
      events: { book_shelved: event([site('web/a.ts', 1, ['web'])]) },
      builtins: {
        ...WITH_TABLE,
        conditional: ['$cashier', '$till_open'],
        off: ['$aisle', '$shelf_view'],
      },
    });
    const m = mergeCatalogs([a], TABLES);
    expect(propertyFact(m, 'book_shelved', '$aisle')).toEqual({ fact: 'no', unknown: [] });
    expect(propertyFact(m, 'book_shelved', '$cashier')).toEqual({
      fact: 'unknown',
      unknown: ['conditional-builtin'],
    });
    expect(eventFact(m, '$shelf_view').fact).toBe('no');
    expect(eventFact(m, '$till_open').unknown).toEqual(['conditional-builtin']);
  });

  it('a table this version does not know keeps "no" unknown', () => {
    const a = web({
      events: { book_shelved: event([site('web/a.ts', 1, ['web'])]) },
      builtins: { ...WITH_TABLE, properties: 'shop-sdk@1 till-sdk@2' },
    });
    const m = mergeCatalogs([a], TABLES);
    expect(m.sources[0]?.unknownTables).toEqual(['till-sdk@2']);
    expect(propertyFact(m, 'book_shelved', 'shelf').unknown).toEqual(['unknown-builtin-table']);
    expect(eventFact(m, 'book_burned').unknown).toEqual(['unknown-builtin-table']);
    expect(personPropertyFact(m, 'loyalty').unknown).toEqual(['unknown-builtin-table']);
  });

  it('uncitable name prefixes are unknown (ADR-003)', () => {
    const a = web({
      events: { book_shelved: event([site('web/a.ts', 1, ['web'])]) },
      builtins: WITH_TABLE,
    });
    const m = mergeCatalogs([a], TABLES);
    expect(eventFact(m, '$survey_shown').unknown).toEqual(['uncitable-name']);
    expect(propertyFact(m, 'book_shelved', '$feature/gift').unknown).toEqual(['uncitable-name']);
    expect(personPropertyFact(m, '$geo_city').unknown).toEqual(['uncitable-name']);
    expect(eventFact(m, 'survey_shown').fact).toBe('no');
  });
});

describe('person properties', () => {
  const person = (file: string) => ({
    loyalty: { sites: [{ file, line: 3, call: 'identify.$set' }] },
  });

  it('unions sites by source; builtin person properties of a table count', () => {
    const a = web({
      personProperties: person('web/login.ts'),
      builtins: { ...WITH_TABLE, off: ['$loyalty_tier'] },
    });
    const b = mobile({ personProperties: person('mobile/login.ts') });
    const m = mergeCatalogs([a, b], TABLES);
    expect(m.personProperties.loyalty?.sites.map((s) => s.source)).toEqual([0, 1]);
    expect(personPropertyFact(m, 'loyalty')).toEqual({ fact: 'yes', unknown: [] });
    expect(personPropertyFact(m, '$first_aisle').fact).toBe('yes');
    expect(personPropertyFact(m, '$loyalty_tier').fact).toBe('no');
    expect(personPropertyFact(m, 'favourite_genre').fact).toBe('no');
  });

  it('an open person call in any catalog keeps "no" unknown', () => {
    const m = mergeCatalogs([web(), mobile({ coverage: { openPersonSites: 2 } })], NO_TABLES);
    expect(personPropertyFact(m, 'favourite_genre').unknown).toEqual(['open-person-properties']);
  });
});

describe('edge cases', () => {
  it('no catalog: nothing is "no"', () => {
    const m = mergeCatalogs([], NO_TABLES);
    expect(eventFact(m, 'book_shelved').unknown).toEqual(['no-catalog']);
    expect(propertyFact(m, 'book_shelved', 'isbn').unknown).toEqual(['event-not-sent']);
    expect(personPropertyFact(m, 'loyalty').unknown).toEqual(['no-catalog']);
  });

  it('names that are Object.prototype keys are plain names', () => {
    const a = web({
      events: { constructor: event([site('web/a.ts', 1, ['web'])], { toString: always() }) },
    });
    const m = mergeCatalogs([a], NO_TABLES);
    expect(eventFact(m, 'constructor').fact).toBe('yes');
    expect(eventFact(m, 'hasOwnProperty').fact).toBe('no');
    expect(propertyFact(m, 'constructor', 'toString').fact).toBe('yes');
    expect(propertyFact(m, 'constructor', 'valueOf').fact).toBe('no');
    expect(propertyFact(m, 'toString', 'x').unknown).toEqual(['event-not-sent']);
    expect(personPropertyFact(m, '__proto__').fact).toBe('no');
  });
});

describe('merge of extracted catalogs (posthog-js web and posthog-react-native mobile)', () => {
  const loaded = loadDescriptors();
  if (!loaded.ok) throw new Error('descriptors do not load');
  const descriptors = loaded.value;
  const extract = (repo: string, name: string, platforms: string[]): Catalog => {
    const input: ExtractInput = {
      repoRoot: join(FIXTURES, repo),
      source: { name, path: '.' },
      descriptors,
      tool: '0.0.0-test',
      platforms,
      commit: null,
    };
    const r = extractCatalog(input);
    if (!r.ok) throw new Error(r.error);
    return r.value.catalog;
  };
  const webCatalog = extract('posthog-js/super', 'web', ['web']);
  const mobileCatalog = extract('posthog-react-native/platforms', 'mobile', ['ios', 'android']);
  const m = mergeCatalogs([webCatalog, mobileCatalog], builtinTables(descriptors));

  it('keeps every event of both, with the platforms of each site', () => {
    const names = new Set([
      ...Object.keys(webCatalog.events),
      ...webCatalog.builtins.events,
      ...Object.keys(mobileCatalog.events),
      ...mobileCatalog.builtins.events,
    ]);
    expect(Object.keys(m.events).sort()).toEqual([...names].sort());
    expect(m.events.wishlist_shared?.senders).toEqual([1]);
    // share.web.ts keeps its suffix's platform in a mobile source (ADR-027).
    expect(m.events.wishlist_shared?.platforms).toEqual(['android', 'ios', 'web']);
    expect(m.events.wishlist_shared?.sites.map((s) => s.platforms)).toEqual(
      mobileCatalog.events.wishlist_shared?.sites.map((s) => s.platforms),
    );
  });

  it('web super properties reach web events only', () => {
    const supers = Object.keys(webCatalog.superProperties);
    expect(supers.length).toBeGreaterThan(0);
    for (const name of supers) expect(m.events.wishlist_shared?.properties[name]).toBeUndefined();
    for (const [event, e] of Object.entries(m.events)) {
      if (!e.senders.includes(0)) continue;
      for (const name of supers) expect(propertyFact(m, event, name).fact).toBe('yes');
    }
  });
});
