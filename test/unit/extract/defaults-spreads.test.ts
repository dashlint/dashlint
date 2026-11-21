// T11.5a (ADR-070): a parameter with no declared type and a `null` default holds an open value,
// not [null]; a spread of the global `Object` type makes the site's properties open; members of
// Object.prototype and class methods and accessors are never listed as properties. Fixtures are
// mini repos with synthetic bookshop names, for posthog-js and mixpanel-browser, in JavaScript and
// TypeScript.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import {
  createSourceProgram,
  findSdkCalls,
  followWrappers,
  resolveEventNames,
  resolveProperties,
  resolveSuperProperties,
  type PropertyScan,
  type PropertySite,
  type SuperScan,
} from '../../../src/extract/index.js';
import { perMutant } from '../per-mutant.js';

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

function only(s: PropertyScan, event: string): PropertySite {
  const sites = s.sites.filter((p) => p.site.names.includes(event));
  expect(sites, event).toHaveLength(1);
  return sites[0] as PropertySite;
}

const set = (...values: (string | number | boolean | null)[]) => ({
  kind: 'finite' as const,
  set: values,
});
const open = (type: 'string' | 'number' | 'boolean' | 'object' | 'unknown') => ({
  kind: 'open' as const,
  type,
});

const PROTOTYPE = [
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
];

describe('posthog-js: a null default with no declared type (ADR-070 A)', () => {
  const fixture = perMutant(() => scan('posthog-js/defaults-spreads'));
  let s: PropertyScan;
  beforeEach(() => {
    s = fixture();
  });

  it('is open with a string caller (JavaScript)', () => {
    const site = only(s, 'shelf_form_submitted');
    expect(site.properties.error_message).toEqual({ presence: 'always', values: open('unknown') });
    expect(site.openProperties).toBe(false);
  });

  it('is open with no caller, in a shorthand and destructured', () => {
    expect(only(s, 'review_saved').properties.note?.values).toEqual(open('unknown'));
    expect(only(s, 'shelf_moved').properties.from?.values).toEqual(open('unknown'));
  });

  it('is open in TypeScript when the parameter has no declared type', () => {
    expect(only(s, 'spine_read').properties.label?.values).toEqual(open('unknown'));
  });

  it('keeps a declared type: JSDoc null, JSDoc union, string | null and a literal union', () => {
    expect(only(s, 'list_cleared').properties.reason?.values).toEqual(set(null));
    expect(only(s, 'badge_shown').properties.badge?.values).toEqual(set('staff', null));
    expect(only(s, 'cover_zoomed').properties.size?.values).toEqual(open('string'));
    expect(only(s, 'format_picked').properties.format?.values).toEqual(set('paperback', null));
  });

  it('keeps a literal null written at the call', () => {
    expect(only(s, 'note_cleared').properties.note).toEqual({
      presence: 'always',
      values: set(null),
    });
  });
});

describe('posthog-js: spreads (ADR-070 B)', () => {
  const fixture = perMutant(() => scan('posthog-js/defaults-spreads'));
  let s: PropertyScan;
  beforeEach(() => {
    s = fixture();
  });

  it('a JSDoc {Object} spread is open and lists no prototype names', () => {
    const site = only(s, 'page_opened');
    expect(site.openProperties).toBe(true);
    expect(Object.keys(site.properties)).toEqual(['pageName']);
    const reason = s.openWorld.find((o) => o.kind === 'properties' && o.file === 'src/pages.js');
    expect(reason?.reason).toBe('the properties have type `Object`, which accepts any object');
  });

  it('a TypeScript Object spread is open and lists no prototype names', () => {
    const site = only(s, 'genre_browsed');
    expect(site.openProperties).toBe(true);
    expect(Object.keys(site.properties)).toEqual(['genre']);
  });

  it('a Record spread stays open with the keys written', () => {
    const site = only(s, 'shelf_filtered');
    expect(site.openProperties).toBe(true);
    expect(Object.keys(site.properties)).toEqual(['shelf']);
  });

  it('an object type and an object literal stay closed with their keys', () => {
    const rated = only(s, 'book_rated');
    expect(rated.openProperties).toBe(false);
    expect(Object.keys(rated.properties)).toEqual(['staffPick', 'stars']);
    const shelved = only(s, 'book_shelved');
    expect(shelved.openProperties).toBe(false);
    expect(shelved.properties).toEqual({ genre: { presence: 'always', values: set('poetry') } });
  });

  it('a class instance sends its fields, never its methods or accessors', () => {
    const site = only(s, 'basket_viewed');
    expect(site.openProperties).toBe(false);
    expect(site.properties).toEqual({
      currency: { presence: 'always', values: set('EUR') },
      items: { presence: 'always', values: open('number') },
    });
  });

  it('no site lists a prototype name', () => {
    const keys = s.sites.flatMap((p) => Object.keys(p.properties));
    for (const name of PROTOTYPE) expect(keys, name).not.toContain(name);
  });
});

describe('posthog-js: more defaults and keys a spread never sends (ADR-070)', () => {
  const fixture = perMutant(() => scan('posthog-js/defaults-spreads-more'));
  let s: PropertyScan;
  beforeEach(() => {
    s = fixture();
  });

  it('an undefined default with no declared type is open and may be left out', () => {
    expect(only(s, 'wish_saved').properties.title).toEqual({
      presence: 'sometimes',
      values: open('unknown'),
    });
  });

  it('negative: a string default with no declared type is read from its type', () => {
    expect(only(s, 'aisle_visited').properties.aisle).toEqual({
      presence: 'always',
      values: open('string'),
    });
  });

  it('a null default read through parentheses is open', () => {
    expect(only(s, 'tag_added').properties.tag?.values).toEqual(open('unknown'));
  });

  it('a name nothing declares is open and the scan goes on', () => {
    expect(only(s, 'ghost_seen').properties.ghost?.values).toEqual(open('unknown'));
  });

  it('members inherited from Object and Function are never keys', () => {
    expect(Object.keys(only(s, 'shelf_opened').properties)).toEqual(['name']);
    expect(Object.keys(only(s, 'hook_ran').properties)).toEqual(['label']);
  });

  it('a symbol key is never a key', () => {
    const site = only(s, 'till_opened');
    expect(site.openProperties).toBe(false);
    expect(Object.keys(site.properties)).toEqual(['drawer']);
  });
});

describe('posthog-react-native: identify with an {Object} value (ADR-070)', () => {
  const fixture = perMutant(() => {
    const r = createSourceProgram({
      repoRoot: join(FIXTURES, 'posthog-react-native/people-object'),
      source: { name: 'app', path: '.' },
      descriptors,
    });
    if (!r.ok) throw new Error(r.error);
    return resolveSuperProperties(r.value, findSdkCalls(r.value, descriptors).calls);
  });
  let s: SuperScan;
  beforeEach(() => {
    s = fixture();
  });

  it('sets no prototype names and is open, as an `object` value is', () => {
    expect(Object.keys(s.personProperties)).toEqual(['plan']);
    expect(s.openWorld.map((o) => `${o.line} ${o.reason}`)).toEqual([
      '11 person properties: the properties have type `Object`, which accepts any object',
      '11 person properties: the properties are read from `$set_once`, which their value does not have',
    ]);
    expect(s.openPersonSites).toBe(2);
  });
});

describe('mixpanel-browser: null defaults and spreads (ADR-070)', () => {
  const fixture = perMutant(() => scan('mixpanel-browser/defaults-spreads'));
  let s: PropertyScan;
  beforeEach(() => {
    s = fixture();
  });

  it('a null default with a string caller is open; a JSDoc union keeps its set', () => {
    expect(only(s, 'Shelf Form Submitted').properties.error_message?.values).toEqual(
      open('unknown'),
    );
    expect(only(s, 'Badge Shown').properties.badge?.values).toEqual(set('staff', null));
  });

  it('TypeScript declared types are unchanged', () => {
    expect(only(s, 'Cover Zoomed').properties.size?.values).toEqual(open('string'));
    expect(only(s, 'Format Picked').properties.format?.values).toEqual(set('paperback', null));
  });

  it('a JSDoc {Object} spread is open with no prototype names; a literal stays closed', () => {
    const page = only(s, 'Page Opened');
    expect(page.openProperties).toBe(true);
    expect(Object.keys(page.properties)).toEqual(['pageName']);
    const shelved = only(s, 'Book Shelved');
    expect(shelved.openProperties).toBe(false);
    expect(Object.keys(shelved.properties)).toEqual(['genre']);
  });

  it('Record spreads stay open, object types and class instances closed without methods', () => {
    expect(only(s, 'Shelf Filtered').openProperties).toBe(true);
    const rated = only(s, 'Book Rated');
    expect(rated.openProperties).toBe(false);
    expect(Object.keys(rated.properties)).toEqual(['staffPick', 'stars']);
    const basket = only(s, 'Basket Viewed');
    expect(basket.openProperties).toBe(false);
    expect(Object.keys(basket.properties)).toEqual(['items']);
  });
});
