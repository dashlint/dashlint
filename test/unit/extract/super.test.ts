import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import {
  createSourceProgram,
  findIdentityCalls,
  findSdkCalls,
  resolveSuperProperties,
  type SourceProgram,
  type SuperScan,
} from '../../../src/extract/index.js';
import { perMutant } from '../per-mutant.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;

function program(repo: string): SourceProgram {
  const r = createSourceProgram({
    repoRoot: join(FIXTURES, repo),
    source: { name: 'app', path: '.' },
    descriptors,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function scan(repo: string): SuperScan {
  const sp = program(repo);
  return resolveSuperProperties(sp, findSdkCalls(sp, descriptors).calls);
}

const webScan = perMutant(() => scan('posthog-js/super'));
const nativeScan = perMutant(() => scan('posthog-react-native/people'));
let web: SuperScan;
let native: SuperScan;
beforeEach(() => {
  web = webScan();
  native = nativeScan();
});

describe('resolveSuperProperties: super properties', () => {
  it('register adds each key as a sometimes super property with its values and sites', () => {
    expect(web.superProperties.shelf_theme).toEqual({
      presence: 'sometimes',
      values: { kind: 'finite', set: ['dark', 'light'] },
      sites: [{ file: 'src/boot.ts', line: 12, call: 'register' }],
    });
  });

  it('register_once counts too, and values from several calls are unioned', () => {
    expect(web.superProperties.storefront).toEqual({
      presence: 'sometimes',
      values: { kind: 'finite', set: ['kiosk', 'web'] },
      sites: [
        { file: 'src/boot.ts', line: 12, call: 'register' },
        { file: 'src/boot.ts', line: 13, call: 'register_once' },
      ],
    });
    expect(web.superProperties.first_visit?.values).toEqual({ kind: 'finite', set: [true] });
  });

  it('an open register argument is counted and listed with its reason, never guessed', () => {
    expect(web.openSuperSites).toBe(1);
    expect(web.openWorld).toContainEqual({
      file: 'src/account.ts',
      line: 14,
      kind: 'properties',
      reason:
        'super properties: the properties have type `Record<string, string>`, which has an index signature',
    });
  });

  it('person calls are not super properties, and React Native register works the same', () => {
    expect(Object.keys(web.superProperties)).toEqual(['first_visit', 'shelf_theme', 'storefront']);
    expect(Object.keys(native.superProperties)).toEqual(['storefront']);
    expect(native.openSuperSites).toBe(0);
  });
});

describe('resolveSuperProperties: person properties', () => {
  it('identify $set and $set_once, setPersonProperties and people.set fill person properties', () => {
    expect(web.personProperties).toEqual({
      favourite_genre: { sites: [{ file: 'src/account.ts', line: 5, call: 'identify.$set' }] },
      first_shelf: { sites: [{ file: 'src/account.ts', line: 5, call: 'identify.$set_once' }] },
      joined_via: { sites: [{ file: 'src/account.ts', line: 9, call: 'people.set_once' }] },
      loyalty_tier: {
        sites: [{ file: 'src/account.ts', line: 6, call: 'setPersonProperties.$set' }],
      },
      newsletter: { sites: [{ file: 'src/account.ts', line: 7, call: 'people.set' }] },
      plan: { sites: [{ file: 'src/account.ts', line: 5, call: 'identify.$set' }] },
      reading_goal: { sites: [{ file: 'src/account.ts', line: 8, call: 'people.set' }] },
    });
  });

  it('a person property name of type string is open with the reason; identify alone sets nothing', () => {
    expect(web.openPersonSites).toBe(1);
    expect(web.openWorld).toContainEqual({
      file: 'src/account.ts',
      line: 13,
      kind: 'properties',
      reason: 'person properties: the property name has type `string`',
    });
    expect(web.openWorld.filter((o) => o.line === 18)).toEqual([]);
  });

  it('React Native identify: $set when given, otherwise the object itself less $set_once; no $set_once sets nothing', () => {
    expect(native.personProperties).toEqual({
      email: { sites: [{ file: 'src/reader.ts', line: 8, call: 'identify.$set' }] },
      first_shelf: { sites: [{ file: 'src/reader.ts', line: 7, call: 'identify.$set_once' }] },
      joined_via: { sites: [{ file: 'src/reader.ts', line: 8, call: 'identify.$set_once' }] },
      plan: {
        sites: [
          { file: 'src/reader.ts', line: 7, call: 'identify.$set' },
          { file: 'src/reader.ts', line: 9, call: 'identify.$set' },
        ],
      },
    });
    expect(native.openPersonSites).toBe(0);
    expect(native.openWorld).toEqual([]);
  });
});

describe('resolveSuperProperties: React Native identify and register edges (T10.2)', () => {
  const edgesScan = perMutant(() => scan('posthog-react-native/people-edges'));
  let edges: SuperScan;
  beforeEach(() => {
    edges = edgesScan();
  });
  const compact = (s: SuperScan) => ({
    persons: Object.fromEntries(
      Object.entries(s.personProperties).map(([k, p]) => [
        k,
        p.sites.map((x) => `${x.line} ${x.call}`),
      ]),
    ),
    open: s.openWorld.map((o) => `${o.line} ${o.reason}`),
  });

  it('reads each identify object by its shape and type', () => {
    expect(compact(edges).persons).toEqual({
      // A conditional $set: its keys, and the object's own keys as well.
      plan: ['17 identify.$set'],
      email: ['17 identify.$set', '20 identify.$set', '21 identify.$set'],
      // $groups and $set_once are not person properties of the fallback.
      nickname: ['19 identify.$set', '21 identify.$set'],
      since: ['19 identify.$set_once'],
      badge: ['23 identify.$set_once'],
    });
    expect(Object.keys(edges.personProperties)).toEqual([
      'badge',
      'email',
      'nickname',
      'plan',
      'since',
    ]);
  });

  it('is open for an index signature, a union, `object` and a spread; closed types and {} set nothing more', () => {
    const has = 'the properties are read from `$set_once`, which their value does not have';
    expect(compact(edges).open).toEqual([
      '16 person properties: the properties have type `Record<string, string>`, which has an index signature',
      `16 person properties: ${has}`,
      '18 person properties: the properties have type `Record<string, string>`, which has an index signature',
      `21 person properties: ${has}`,
      '22 person properties: the properties have type `object`, which accepts any object',
      `22 person properties: ${has}`,
      '25 person properties: the properties are in a spread argument',
      '25 person properties: the properties are in a spread argument',
      '27 super properties: the properties are in a spread argument',
    ]);
    expect(edges.openPersonSites).toBe(8);
    expect(edges.openSuperSites).toBe(1);
    expect(edges.superProperties).toEqual({});
  });
});

describe('resolveSuperProperties: order', () => {
  const both = perMutant(() =>
    ['posthog-js/super', 'posthog-react-native/people'].map((repo) => {
      const sp = program(repo);
      const calls = findSdkCalls(sp, descriptors).calls;
      return {
        forward: resolveSuperProperties(sp, calls),
        backward: resolveSuperProperties(sp, [...calls].reverse()),
      };
    }),
  );
  const inFileOrder = (sites: readonly { file: string; line: number }[]): boolean =>
    sites.every(
      (s, i) =>
        i === 0 ||
        (sites[i - 1] as { file: string }).file < s.file ||
        ((sites[i - 1] as { file: string }).file === s.file &&
          (sites[i - 1] as { line: number }).line <= s.line),
    );
  const byCodePoint = (names: string[]): string[] =>
    [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  it('gives the same scan, names by code point and sites in file order, whatever the order of the calls', () => {
    for (const { forward, backward } of both()) {
      expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
      for (const scan of [forward, backward]) {
        const supers = Object.keys(scan.superProperties);
        const persons = Object.keys(scan.personProperties);
        expect(supers).toEqual(byCodePoint(supers));
        expect(persons).toEqual(byCodePoint(persons));
        for (const p of [
          ...Object.values(scan.superProperties),
          ...Object.values(scan.personProperties),
        ])
          expect(inFileOrder(p.sites)).toBe(true);
        expect(inFileOrder(scan.openWorld)).toBe(true);
      }
    }
  });

  it('the fixtures have what the order test needs: several sites per name, on different lines', () => {
    const [web] = both();
    const multi = Object.values(web?.forward.superProperties ?? {}).filter(
      (p) => new Set(p.sites.map((s) => `${s.file}:${s.line}`)).size > 1,
    );
    expect(multi.length).toBeGreaterThan(0);
    expect(web?.forward.openWorld.length).toBeGreaterThan(1);
    const names = Object.keys(web?.forward.superProperties ?? {});
    expect(names).not.toEqual([...names].reverse());
  });
});

describe('findIdentityCalls', () => {
  const identityScan = perMutant(() => {
    const sp = program('posthog-js/super');
    return findIdentityCalls(findSdkCalls(sp, descriptors).calls);
  });
  let identity: ReturnType<typeof findIdentityCalls>;
  beforeEach(() => {
    identity = identityScan();
  });
  const at = (file: string, line: number) =>
    identity.find((c) => c.file === file && c.line === line);

  it('records reset and identify with the file and line of the call', () => {
    expect(identity.filter((c) => c.call === 'identify').map((c) => c.line)).toEqual([5, 18]);
    expect(identity.filter((c) => c.call === 'reset')).toHaveLength(10);
  });

  it('module-init: a call at module level', () => {
    expect(at('src/boot.ts', 15)?.context).toBe('module-init');
  });

  it('mount-effect: an effect with no dependencies (also through a then callback) and componentDidMount', () => {
    expect(at('src/session.tsx', 9)?.context).toBe('mount-effect');
    expect(at('src/session.tsx', 12)?.context).toBe('mount-effect');
    expect(at('src/session.tsx', 36)?.context).toBe('mount-effect');
  });

  it('handler: an on* prop, a handle* or sign-out function, an event listener', () => {
    expect(at('src/session.tsx', 17)?.context).toBe('handler');
    expect(at('src/session.tsx', 21)?.context).toBe('handler');
    expect(at('src/session.tsx', 25)?.context).toBe('handler');
    expect(at('src/session.tsx', 32)?.context).toBe('handler');
  });

  it('other: an effect with dependencies and a plain helper', () => {
    expect(at('src/session.tsx', 15)?.context).toBe('other');
    expect(at('src/session.tsx', 29)?.context).toBe('other');
    expect(at('src/account.ts', 18)?.context).toBe('other');
  });
});
