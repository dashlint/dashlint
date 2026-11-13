import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import {
  createSourceProgram,
  eventPropertyFact,
  followWrappers,
  MAX_VALUES,
  mergeSiteProperties,
  resolveEventNames,
  resolveProperties,
  unionDomains,
  type PropertyScan,
  type PropertySite,
} from '../../../src/extract/index.js';
import type { PropertyFact } from '../../../src/formats/catalog.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;

function scan(repo: string): PropertyScan {
  const r = createSourceProgram({
    repoRoot: join(FIXTURES, repo),
    source: { name: 'app', path: '.' },
    descriptors,
  });
  if (!r.ok) throw new Error(r.error);
  const names = resolveEventNames(r.value, followWrappers(r.value, descriptors));
  return resolveProperties(r.value, names);
}

const fixture = scan('posthog-js/properties');

/** The sites that send `event`, in file order. */
function sitesOf(s: PropertyScan, event: string): PropertySite[] {
  return s.sites.filter((p) => p.site.names.includes(event));
}

/** The `n`th site that sends `event`. */
function nth(event: string, n: number, s = fixture): PropertySite {
  const site = sitesOf(s, event)[n];
  if (!site) throw new Error(`no site ${n} for ${event}`);
  return site;
}

/** The properties of the one site that sends `event`. */
function only(event: string, s = fixture): PropertySite {
  expect(sitesOf(s, event), event).toHaveLength(1);
  return nth(event, 0, s);
}

const always = (values: PropertyFact['values']): PropertyFact => ({ presence: 'always', values });
const sometimes = (values: PropertyFact['values']): PropertyFact => ({
  presence: 'sometimes',
  values,
});
const set = (...values: (string | number | boolean | null)[]) => ({
  kind: 'finite' as const,
  set: values,
});
const open = (type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown') => ({
  kind: 'open' as const,
  type,
});

describe('resolveProperties: values', () => {
  it('literals keep their JSON type: true, "true", 3 and null are different values', () => {
    expect(sitesOf(fixture, 'book_opened')).toHaveLength(2);
    const first = nth('book_opened', 0);
    expect(first.properties).toEqual({
      channel: always(set('link')),
      copies: always(set(3)),
      in_stock: always(set(true)),
      note: always(set(null)),
      stocked: always(set('true')),
    });
    expect(first.openProperties).toBe(false);
    expect(nth('book_opened', 1).properties['in_stock']).toEqual(always(set('true')));
  });

  it('a union of literals, boolean, a string enum, a number enum and an enum member are finite', () => {
    expect(only('book_shared').properties).toEqual({
      channel: always(set('email', 'link')),
      format: always(set('ebook', 'paper')),
      gift_wrapped: always(set(true, false)),
      shelf: always(set(1, 2)),
      top: always(set(1)),
      wrap: always(set('no', 'yes')),
    });
  });

  it('anything else is open with its primitive type', () => {
    const p = only('book_read').properties;
    expect(p['title']).toEqual(always(open('string')));
    expect(p['pages']).toEqual(always(open('number')));
    expect(p['tags']).toEqual(always(open('array')));
    expect(p['author']).toEqual(always(open('object')));
    // `null` does not change the type; two primitives make it unknown.
    expect(p['coupon']).toEqual(always(open('string')));
    expect(p['code']).toEqual(always(open('unknown')));
    expect(p['anything']).toEqual(always(open('unknown')));
  });

  it(`at most ${MAX_VALUES} values are finite; one more is open`, () => {
    const p = only('book_read').properties;
    expect(p['aisle50']?.values.kind).toBe('finite');
    expect((p['aisle50']?.values as { set: unknown[] }).set).toHaveLength(MAX_VALUES);
    expect(p['aisle']).toEqual(always(open('string')));
  });
});

describe('resolveProperties: presence', () => {
  it('an optional property or a value that may be undefined is sometimes', () => {
    expect(only('review_saved').properties).toEqual({
      draft: sometimes(set(true, false)),
      rating: sometimes(open('number')),
      title: always(open('string')),
    });
    // A value that is only `undefined` is never sent.
    expect(only('review_noted').properties).toEqual({ note: sometimes(open('string')) });
  });

  it('conditional spreads are sometimes, and keep their literals', () => {
    expect(only('basket_viewed').properties).toEqual({
      coupon: sometimes(open('string')),
      items: always(set(2)),
      loyalty: sometimes(set(true)),
      reader: sometimes(set('member')),
    });
  });

  it('a choice between objects: a key in every branch is always sent', () => {
    expect(only('basket_paid').properties).toEqual({
      method: always(set('card', 'voucher')),
      voucher: sometimes(set('gift')),
    });
    expect(only('basket_left').properties).toEqual({ muted: sometimes(set(true)) });
  });

  it('a later key replaces an earlier one; one sent sometimes leaves the earlier value possible', () => {
    expect(only('shop_entered').properties).toEqual({ source: always(set('web')) });
    expect(only('shop_left').properties).toEqual({ source: always(set('app', 'web')) });
  });

  it('a later key written as undefined removes the earlier value', () => {
    expect(only('shop_cleared')).toMatchObject({ properties: {}, openProperties: false });
    expect(only('shop_unset').properties).toEqual({ source: sometimes(set('web')) });
    // Written only when signed in, and then perhaps as undefined: either value, or none.
    expect(only('shop_unsure').properties).toEqual({ source: sometimes(set('app', 'web')) });
  });

  it('a computed key of literal names writes one of them', () => {
    expect(only('shop_browsed').properties).toEqual({
      author: sometimes(set('poetry')),
      fixed: always(set(1)),
      genre: sometimes(set('poetry')),
    });
  });

  it("'', 0 and false spread nothing; && is sometimes only when its left side can be falsy", () => {
    expect(only('shop_wrapped').properties).toEqual({
      long: sometimes(set(true)),
      online: always(set(true)),
      wrapping: sometimes(set('gift')),
    });
  });

  it('a method and a getter are sent, with open values', () => {
    expect(only('shop_counted').properties).toEqual({
      count: always(open('object')),
      size: always(open('unknown')),
    });
  });

  it('no properties, null and {} send nothing and are not open', () => {
    for (const event of ['shop_closed', 'shop_paused', 'shop_reset'])
      expect(only(event), event).toMatchObject({ properties: {}, openProperties: false });
  });
});

describe('resolveProperties: open properties', () => {
  const reasons = Object.fromEntries(
    fixture.openWorld
      .filter((o) => o.kind === 'properties')
      .map((o) => [`${o.file}:${o.line}`, o.reason]),
  );

  it('an index signature, any, object, {}, a type parameter or a computed string key make the site open', () => {
    expect(reasons).toEqual({
      'src/open.ts:13':
        'the properties have type `Record<string, unknown>`, which has an index signature',
      'src/open.ts:14': 'the properties have type `any`',
      'src/open.ts:15': 'the properties have type `object`, which accepts any object',
      'src/open.ts:16': 'the properties have type `{}`, which accepts any object',
      'src/open.ts:17': 'a property name has type `string`',
      'src/open.ts:18':
        'the properties have type `Record<string, unknown>`, which has an index signature',
      'src/open.ts:22': 'the properties have type `T`, a type parameter',
      'src/open.ts:43': 'the properties have type `42`, not an object',
      'src/open.ts:44': 'the properties have type `string[]`, not an object',
      'src/open.ts:46': 'the properties are in a spread argument',
      'src/open.ts:51':
        'the properties have type `T & { items: number; }`, which includes a type parameter',
      'src/open.ts:60': 'the properties have type `any`',
    });
    for (const event of [
      'cart_emptied',
      'cart_shared',
      'cart_named',
      'cart_checked',
      'cart_saved',
      'cart_counted',
      'cart_listed',
      'cart_split',
    ])
      expect(only(event), event).toMatchObject({ properties: {}, openProperties: true });
    // The same wrapper given an object literal is closed.
    expect(only('cart_kept')).toEqual(
      expect.objectContaining({ properties: { items: always(set(5)) }, openProperties: false }),
    );
  });

  it('properties written beside an open spread are still listed', () => {
    expect(nth('cart_viewed', 0)).toMatchObject({
      openProperties: true,
      properties: { items: always(set(2)) },
    });
    expect(only('cart_tagged')).toMatchObject({
      openProperties: true,
      properties: { items: always(set(3)) },
    });
    expect(only('cart_mixed')).toMatchObject({
      openProperties: true,
      properties: { items: always(open('number')) },
    });
    expect(only('cart_loaded')).toMatchObject({ openProperties: true, properties: {} });
  });

  it('open properties are not open event names: the name-resolution counts are unchanged', () => {
    expect(fixture.openWorld.filter((o) => o.kind === 'event-name')).toEqual([]);
  });
});

describe('resolveProperties: wrappers and SDK-added properties', () => {
  it("at a wrapper's call the argument's own type decides", () => {
    expect(only('reader_joined').properties).toEqual({ plan: always(set('monthly')) });
    expect(only('reader_joined').openProperties).toBe(false);
  });

  it('a properties argument left out sends nothing', () => {
    expect(only('reader_left')).toMatchObject({ properties: {}, openProperties: false });
  });

  it('literal keys a wrapper adds are added at every call', () => {
    expect(only('reader_browsed').properties).toEqual({
      source: always(set('web')),
      title: always(open('string')),
    });
  });

  it('properties read from an object argument and a parameter default', () => {
    expect(only('reader_scanned').properties).toEqual({ isbn: always(open('string')) });
    expect(only('reader_picked').properties).toEqual({ list: always(set('staff_picks')) });
    expect(only('reader_chose').properties).toEqual({ list: always(set('new_in')) });
    expect(only('reader_rescanned').properties).toEqual({
      edition: sometimes(open('number')),
      isbn: always(open('string')),
    });
  });

  it('react native screen adds $screen_name from the screen name', () => {
    const rn = scan('posthog-react-native/calls');
    const screens = sitesOf(rn, '$screen');
    expect(screens.map((s) => s.properties)).toEqual([
      { $screen_name: always(set('Shelf')), shelf_id: always(open('string')) },
      { $screen_name: always(set('ReadingList')) },
    ]);
  });
});

describe('mergeSiteProperties and eventPropertyFact', () => {
  it('always only when every site sends it always; values are unioned with JSON types kept', () => {
    const merged = mergeSiteProperties(sitesOf(fixture, 'book_opened'));
    expect(merged).toEqual({
      openSites: 0,
      properties: {
        channel: always(set('email', 'link')),
        copies: always(set(3)),
        in_stock: always(set('true', true)),
        note: sometimes(set(null)),
        stocked: sometimes(set('true')),
      },
    });
    expect(eventPropertyFact(merged, 'channel')).toBe('yes');
    expect(eventPropertyFact(merged, 'stocked')).toBe('yes');
    expect(eventPropertyFact(merged, 'shelf_id')).toBe('no');
  });

  it('negative control: an open spread leaves the event\'s "no" property facts unknown', () => {
    const viewed = mergeSiteProperties(sitesOf(fixture, 'cart_viewed'));
    expect(viewed.openSites).toBe(1);
    expect(viewed.properties).toEqual({
      gift: sometimes(set(false)),
      items: always(set(1, 2)),
    });
    expect(eventPropertyFact(viewed, 'items')).toBe('yes');
    expect(eventPropertyFact(viewed, 'coupon')).toBe('unknown');
    // The control: an event sent only from closed sites has a definite "no".
    const restocked = mergeSiteProperties(sitesOf(fixture, 'cart_restocked'));
    expect(eventPropertyFact(restocked, 'coupon')).toBe('no');
  });

  it('no sites: nothing listed, nothing open', () => {
    expect(mergeSiteProperties([])).toEqual({ openSites: 0, properties: {} });
  });
});

describe('unionDomains', () => {
  it('finite sets union, sorted strings, numbers, true, false, null', () => {
    expect(unionDomains(set(null, 'b', 2), set(false, 'a', true, 1))).toEqual(
      set('a', 'b', 1, 2, true, false, null),
    );
  });

  it('more than the limit becomes open with the shared type', () => {
    const a = set(...Array.from({ length: 30 }, (_, i) => `a${i}`));
    const b = set(...Array.from({ length: 21 }, (_, i) => `b${i}`));
    expect(unionDomains(a, b)).toEqual(open('string'));
    const c = set(...Array.from({ length: 20 }, (_, i) => `b${i}`));
    expect(unionDomains(a, c)).toEqual(set(...[...a.set, ...c.set].sort()));
  });

  it('finite with open keeps the type only when every value has it; null alone does not change it', () => {
    expect(unionDomains(set('a'), open('string'))).toEqual(open('string'));
    expect(unionDomains(set(1), open('string'))).toEqual(open('unknown'));
    expect(unionDomains(set(null), open('number'))).toEqual(open('number'));
    expect(unionDomains(open('number'), set(null))).toEqual(open('number'));
    expect(unionDomains(open('array'), open('object'))).toEqual(open('unknown'));
  });
});
