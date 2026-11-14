import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import {
  createSourceProgram,
  followWrappers,
  MAX_NAMES,
  nameResolutionRate,
  resolveEventNames,
  type NameScan,
} from '../../../src/extract/index.js';
import { perMutant } from '../per-mutant.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;

function names(repo: string, path = '.'): NameScan {
  const r = createSourceProgram({
    repoRoot: join(FIXTURES, repo),
    source: { name: 'app', path },
    descriptors,
  });
  if (!r.ok) throw new Error(r.error);
  return resolveEventNames(r.value, followWrappers(r.value, descriptors));
}

/** `file:line` to the names of the one site there. */
function named(s: NameScan): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of s.sites) {
    const where = `${n.event.file}:${n.event.line}`;
    expect(out[where], where).toBeUndefined();
    out[where] = n.names;
  }
  return out;
}

function open(s: NameScan, kind = 'event-name'): Record<string, string> {
  return Object.fromEntries(
    s.openWorld.filter((o) => o.kind === kind).map((o) => [`${o.file}:${o.line}`, o.reason]),
  );
}

const fixtureScan = perMutant(() => names('posthog-js/names'));
let fixture: NameScan;
beforeEach(() => {
  fixture = fixtureScan();
});
const aisles50 = ['0', '1', '2', '3', '4'].flatMap((t) =>
  ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => `aisle_${t}${d}`),
);

describe('resolveEventNames: names from types', () => {
  let n: Record<string, string[]>;
  beforeEach(() => {
    n = named(fixture);
  });

  it('a string literal, directly and through a const', () => {
    expect(n['src/direct.ts:25']).toEqual(['book_opened']);
    expect(n['src/direct.ts:26']).toEqual(['book_shelved']);
  });

  it('a union of literals gives each name', () => {
    expect(n['src/direct.ts:27']).toEqual(['shelf_closed', 'shelf_opened']);
  });

  it('an enum member gives its value, an enum type each value', () => {
    expect(n['src/direct.ts:28']).toEqual(['shop_opened']);
    expect(n['src/direct.ts:29']).toEqual(['shop_closed', 'shop_opened']);
  });

  it('a finite template literal type and a template of literal parts are expanded', () => {
    expect(n['src/direct.ts:30']).toEqual(['shelf_bottom_moved', 'shelf_top_moved']);
    expect(n['src/direct.ts:31']).toEqual(['genre_drama_browsed', 'genre_poetry_browsed']);
    // A numeric enum member in a template is its number's text, as numbers and booleans are.
    expect(n['src/direct.ts:33']).toEqual(['aisle_1']);
    expect(n['src/direct.ts:41']).toEqual(['floor_1', 'floor_2']);
    expect(n['src/direct.ts:42']).toEqual(['gift_false', 'gift_true']);
    // Given to a `string` parameter the template's type is `string`: expanded from its parts.
    expect(n['src/wrapped.ts:47']).toEqual(['floor_1', 'floor_2']);
    expect(n['src/wrapped.ts:48']).toEqual(['gift_false', 'gift_true']);
  });

  it('JSDoc types in JavaScript; `undefined` names no event', () => {
    expect(n['src/legacy.js:11']).toEqual(['gift_sent']);
  });

  it('exactly MAX_NAMES names are names', () => {
    expect(MAX_NAMES).toBe(50);
    expect(n['src/direct.ts:32']).toEqual(aisles50);
  });

  it('a literal-union wrapper parameter resolves at each call of the wrapper', () => {
    expect(n['src/wrapped.ts:30']).toEqual(['shelf_opened']);
    expect(n['src/wrapped.ts:31']).toEqual(['shelf_closed', 'shelf_opened']);
    // The parameter's default when the call leaves the name out.
    expect(n['src/wrapped.ts:32']).toEqual(['page_viewed']);
    expect(n['src/wrapped.ts:33']).toEqual(['page_left']);
    // A name read from an object: the literal the call writes, or the type of the value's key.
    expect(n['src/wrapped.ts:34']).toEqual(['cart_viewed']);
    expect(n['src/wrapped.ts:35']).toEqual(['cart_emptied', 'cart_viewed']);
    // An optional name: `undefined` names no event.
    expect(n['src/wrapped.ts:36']).toEqual(['wishlist_saved']);
    const site = fixture.sites.find(
      (s) => s.event.file === 'src/wrapped.ts' && s.event.line === 30,
    );
    expect(site?.event.via).toEqual(['trackShelf (src/wrapped.ts:6)', 'PostHog.capture']);
  });

  it('no site inside a wrapper, and no other site', () => {
    expect(Object.keys(n).sort()).toEqual(
      [
        ...[25, 26, 27, 28, 29, 30, 31, 32, 33, 41, 42].map((l) => `src/direct.ts:${l}`),
        'src/legacy.js:11',
        ...[30, 31, 32, 33, 34, 35, 36, 47, 48].map((l) => `src/wrapped.ts:${l}`),
      ].sort(),
    );
  });
});

describe('resolveEventNames: open world', () => {
  let o: Record<string, string>;
  beforeEach(() => {
    o = open(fixture);
  });

  it('a union of 51 literals is open world, not 51 names (negative control)', () => {
    expect(o['src/direct.ts:34']).toBe('event name is one of 51 names, more than 50');
    expect(fixture.sites.some((s) => s.names.includes('aisle_extra'))).toBe(false);
  });

  it('a template whose parts give 51 names is open world', () => {
    expect(o['src/direct.ts:35']).toBe('event name is one of 51 names, more than 50');
  });

  it('`string`, `any` and a pattern template type are open world with the type', () => {
    expect(o['src/direct.ts:36']).toBe('event name has type `string`');
    expect(o['src/direct.ts:37']).toBe('event name has type `any`');
    expect(o['src/direct.ts:38']).toBe('event name has type ``review_${string}``');
    expect(o['src/direct.ts:39']).toBe('event name has type `string`');
    expect(o['src/direct.ts:40']).toBe('event name is a template with a part of type `number`');
    expect(o['src/wrapped.ts:49']).toBe('event name is a template with a part of type `number`');
  });

  it('a union with a member that is not a string is open world', () => {
    expect(o['src/legacy.js:10']).toBe('event name has type `"gift_wrapped" | 404`');
  });

  it('a call that leaves the name out, or spreads it, is open world', () => {
    expect(o['src/wrapped.ts:37']).toBe('the call passes no event name');
    expect(o['src/wrapped.ts:38']).toBe('the event name is in a spread argument');
  });

  it('every open site is listed once, in file order', () => {
    expect(fixture.openWorld.map((w) => `${w.file}:${w.line}`)).toEqual([
      ...[34, 35, 36, 37, 38, 39, 40].map((l) => `src/direct.ts:${l}`),
      'src/legacy.js:10',
      'src/wrapped.ts:37',
      'src/wrapped.ts:38',
      'src/wrapped.ts:49',
    ]);
  });
});

describe('resolveEventNames: open names keep their fixed head and tail (ADR-061)', () => {
  const scan = perMutant(() => names('posthog-js/open-templates'));
  let s: NameScan;
  let bounds: Record<string, { prefix: string | undefined; suffix: string | undefined }>;
  beforeEach(() => {
    s = scan();
    bounds = Object.fromEntries(
      s.openWorld.map((o) => [`${o.line}`, { prefix: o.prefix, suffix: o.suffix }]),
    );
  });

  it('a template with a `string` part keeps its literal head and tail', () => {
    expect(bounds['15']).toEqual({ prefix: 'shared_via_', suffix: undefined });
    expect(bounds['16']).toEqual({ prefix: undefined, suffix: '_coupon_redeemed' });
    expect(bounds['17']).toEqual({ prefix: 'gift_', suffix: '_wrapped' });
    // Through a `string` wrapper parameter, at the wrapper's call site.
    expect(bounds['23']).toEqual({ prefix: 'lent_to_', suffix: undefined });
  });

  it('a pattern template type keeps its head and tail', () => {
    expect(bounds['20']).toEqual({ prefix: 'review_', suffix: '_posted' });
  });

  it('negative control: a template with no literal text, or `string`, has no bounds', () => {
    for (const line of ['18', '19', '21', '22']) {
      expect(bounds[line], line).toEqual({ prefix: undefined, suffix: undefined });
      expect(Object.keys(s.openWorld.find((o) => `${o.line}` === line) ?? {})).not.toContain(
        'prefix',
      );
    }
  });

  it('every open template is still an open site, counted once', () => {
    expect(s.openWorld.map((o) => o.line)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(s.coverage).toMatchObject({ callSites: 10, literalNameSites: 1, openSites: 9 });
  });
});

describe('resolveEventNames: other sources', () => {
  it('a member with a fixed name gives it (React Native screen)', () => {
    const n = named(names('posthog-react-native/calls'));
    expect(n['src/direct.ts:7']).toEqual(['shelf_opened']);
    expect(n['src/direct.ts:8']).toEqual(['$screen']);
  });

  it('wrappers: a `let` inside a wrapper is open, a chain cut off is an open site', () => {
    const w = names('posthog-js/wrappers');
    expect(open(w)).toEqual({
      'src/lib/analytics.ts:58': 'event name has type `string`',
      'src/pages/chain.ts:6': expect.stringContaining('more than 5 wrappers'),
    });
    const n = named(w);
    expect(n['src/pages/shelf.ts:20']).toEqual(['book_reserved']);
    expect(n['src/pages/shelf.ts:21']).toEqual(['pick_opened']);
    expect(n['src/pages/chain.ts:5']).toEqual(['five_deep']);
    // 14 event sites: 13 named, the `let` open; plus the call cut off at depth 6.
    expect(w.coverage).toEqual({
      callSites: 15,
      literalNameSites: 13,
      openSites: 2,
      nameResolutionRate: 0.867,
    });
  });

  it('calls from an SDK import that does not resolve are open sites', () => {
    const c = names('posthog-js/calls');
    expect(Object.keys(open(c, 'unresolved-import'))).toEqual(['src/unresolved.ts:8']);
    const counted = c.openWorld.filter(
      (o) => o.kind === 'event-name' || o.kind === 'unresolved-import',
    ).length;
    expect(c.coverage.openSites).toBe(counted);
    expect(c.coverage.callSites).toBe(c.sites.length + counted);
  });
});

describe('resolveEventNames: name-resolution rate', () => {
  it('equals the hand count on the fixture source', () => {
    // direct.ts: 18 calls, 11 named (lines 25 to 33, 41, 42) and 7 open (34 to 40).
    // legacy.js: 2 calls, 1 named, 1 open.
    // wrapped.ts: 12 calls of a wrapper or the SDK outside the wrappers, 9 named (30 to 36, 47,
    // 48), 3 open (37, 38, 49).
    // 21 of 32 named: 0.65625, written 0.656.
    expect(fixture.coverage).toEqual({
      callSites: 32,
      literalNameSites: 21,
      openSites: 11,
      nameResolutionRate: 0.656,
    });
  });

  it('a union site is one call site, whatever its number of names', () => {
    const count = fixture.sites.reduce((sum, s) => sum + s.names.length, 0);
    expect(count).toBeGreaterThan(fixture.coverage.literalNameSites);
  });

  it('rounds to three decimals and is 1 with no call site', () => {
    expect(nameResolutionRate(58, 61)).toBe(0.951);
    expect(nameResolutionRate(2, 3)).toBe(0.667);
    expect(nameResolutionRate(0, 4)).toBe(0);
    expect(nameResolutionRate(0, 0)).toBe(1);
  });
});
