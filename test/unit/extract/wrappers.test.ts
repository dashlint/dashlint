import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDescriptors, type Descriptor } from '../../../src/descriptors/index.js';
import {
  createSourceProgram,
  followWrappers,
  MAX_DEPTH,
  valueAt,
  type EventCall,
  type PropertyPart,
  type WrapperScan,
} from '../../../src/extract/index.js';
import { perMutant } from '../per-mutant.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;

function scan(repo: string, path = '.'): WrapperScan {
  const r = createSourceProgram({
    repoRoot: join(FIXTURES, repo),
    source: { name: 'app', path },
    descriptors,
  });
  if (!r.ok) throw new Error(r.error);
  return followWrappers(r.value, descriptors);
}

const part = (p: PropertyPart): string =>
  'arg' in p
    ? p.arg
    : 'element' in p
      ? `{${p.element.getText()}}`
      : [p.node.getText(), ...p.keys].join('.');

const site = (e: EventCall): string => `${e.file}:${e.line}`;

function at(s: WrapperScan, where: string): EventCall {
  const found = s.events.filter((e) => site(e) === where);
  expect(found, where).toHaveLength(1);
  return found[0] as EventCall;
}

const wrappersScan = perMutant(() => scan('posthog-js/wrappers'));
const sharedScan = perMutant(() => scan('posthog-js/wrappers-shared', 'app'));
let wrappers: WrapperScan;
let shared: WrapperScan;
beforeEach(() => {
  wrappers = wrappersScan();
  shared = sharedScan();
});

describe('followWrappers: posthog-js wrappers', () => {
  it('finds exactly the event sites, none inside a wrapper', () => {
    expect(wrappers.events.map(site)).toEqual([
      'src/lib/analytics.ts:40',
      'src/lib/analytics.ts:58',
      'src/lib/use-shelf-analytics.ts:15',
      'src/pages/chain.ts:5',
      'src/pages/shelf.ts:17',
      'src/pages/shelf.ts:18',
      'src/pages/shelf.ts:19',
      'src/pages/shelf.ts:20',
      'src/pages/shelf.ts:21',
      'src/pages/shelf.ts:22',
      'src/pages/shelf.ts:24',
      'src/pages/shelf.ts:26',
      'src/pages/shelf.ts:33',
      'src/pages/shelf.ts:35',
    ]);
    // The SDK calls inside the wrappers are still matched (T3.3), only not as sites.
    const inside = wrappers.sdkCalls.calls.map((c) => `${c.file}:${c.line}`);
    for (const line of [8, 24, 29, 34, 45]) {
      expect(inside).toContain(`src/lib/analytics.ts:${line}`);
      expect(wrappers.events.map(site)).not.toContain(`src/lib/analytics.ts:${line}`);
    }
  });

  it('a wrapper: the call of it is the site, the SDK call is its via', () => {
    const e = at(wrappers, 'src/pages/shelf.ts:17');
    expect(e.via).toEqual(['track (src/lib/analytics.ts:7)', 'PostHog.capture']);
    expect(e.event).toEqual({ arg: 'args[0]' });
    expect(e.properties.map(part)).toEqual(['args[1]']);
    expect(e.entry.member).toBe('capture');
    expect(e.descriptor.sdk).toBe('posthog-js');
  });

  it('a wrapper of a wrapper', () => {
    const e = at(wrappers, 'src/pages/shelf.ts:18');
    expect(e.via).toEqual([
      'trackShelf (src/lib/analytics.ts:12)',
      'track (src/lib/analytics.ts:7)',
      'PostHog.capture',
    ]);
    expect(e.properties.map(part)).toEqual(['args[1]']);
    expect(wrappers.events.map(site)).not.toContain('src/lib/analytics.ts:13');
  });

  it('a wrapper adding a literal key keeps the parameter and adds the key', () => {
    const e = at(wrappers, 'src/pages/shelf.ts:19');
    expect(e.via[0]).toBe('trackWeb (src/lib/analytics.ts:17)');
    expect(e.properties.map(part)).toEqual(['args[1]', "{source: 'web'}"]);
  });

  it('object parameters: through a const alias and through destructuring', () => {
    const payload = at(wrappers, 'src/pages/shelf.ts:20');
    expect(payload.event).toEqual({ arg: 'args[0].name' });
    expect(payload.properties.map(part)).toEqual(['args[0].props']);
    const picked = at(wrappers, 'src/pages/shelf.ts:21');
    expect(picked.event).toEqual({ arg: 'args[0].name' });
    expect(picked.properties.map(part)).toEqual(['args[1]']);
  });

  it('valueAt reads into object literals and falls back to the parameter default', () => {
    const payload = at(wrappers, 'src/pages/shelf.ts:20');
    expect(valueAt(payload.call, 'args[0].name', payload.callee)?.node.getText()).toBe(
      "'book_reserved'",
    );
    const picked = at(wrappers, 'src/pages/shelf.ts:21');
    expect(picked.callee).toBeDefined();
    expect(valueAt(picked.call, 'args[1]', picked.callee)?.node.getText()).toBe(
      "{ list: 'staff_picks' }",
    );
    // Without the callee a left-out argument has no value.
    expect(valueAt(picked.call, 'args[1]', undefined)).toBeUndefined();
    // A key the literal does not write is left over with the expression.
    expect(valueAt(payload.call, 'args[0].missing', payload.callee)?.keys).toEqual(['missing']);
  });

  it('a class method, a const alias of a wrapper and a recursive wrapper', () => {
    expect(at(wrappers, 'src/pages/shelf.ts:22').via[0]).toBe(
      'ShelfAnalytics.log (src/lib/analytics.ts:33)',
    );
    expect(at(wrappers, 'src/pages/shelf.ts:26').via[0]).toBe('track (src/lib/analytics.ts:7)');
    expect(at(wrappers, 'src/pages/shelf.ts:24').via).toEqual([
      'trackRetry (src/lib/analytics.ts:44)',
      'PostHog.capture',
    ]);
    expect(wrappers.events.map(site)).not.toContain('src/lib/analytics.ts:46');
  });

  it('a hook returning an object of wrappers, destructured and renamed', () => {
    const e = at(wrappers, 'src/pages/shelf.ts:33');
    expect(e.via).toEqual(['track (src/lib/use-shelf-analytics.ts:11)', 'PostHog.capture']);
    expect(e.properties.map(part)).toEqual(['args[1]']);
    const genre = at(wrappers, 'src/pages/shelf.ts:35');
    expect(genre.via[0]).toBe('trackGenre (src/lib/use-shelf-analytics.ts:16)');
    expect(genre.properties.map(part)).toEqual(["{genre: 'poetry'}"]);
  });

  it('not wrappers: a fixed name, a parameter that never reaches the SDK, a let', () => {
    // The fixed-name calls are the sites; the calls of their functions are not.
    expect(at(wrappers, 'src/lib/analytics.ts:40').via).toEqual(['PostHog.capture']);
    expect(at(wrappers, 'src/lib/use-shelf-analytics.ts:15').via).toEqual(['PostHog.capture']);
    const sites = wrappers.events.map(site);
    expect(sites).not.toContain('src/pages/shelf.ts:23');
    expect(sites).not.toContain('src/pages/shelf.ts:34');
    // `logLocal` sends nothing; `trackLater` reads a `let`, so its inside call is the site.
    expect(sites).not.toContain('src/pages/shelf.ts:27');
    expect(sites).not.toContain('src/pages/shelf.ts:28');
    expect(at(wrappers, 'src/lib/analytics.ts:58').event).toEqual({ arg: 'args[0]' });
    const names = wrappers.wrappers.map((w) => w.label.split(' ')[0]);
    expect(names).not.toContain('logLocal');
    expect(names).not.toContain('trackLater');
    expect(names).not.toContain('trackOpened');
    expect(names).not.toContain('trackList');
  });

  it('a skipped test file adds no site and no wrapper', () => {
    expect(wrappers.events.some((e) => e.file.endsWith('.test.ts'))).toBe(false);
    expect(wrappers.wrappers.some((w) => w.label.includes('.test.ts'))).toBe(false);
    expect(wrappers.openWorld.some((o) => o.file.endsWith('.test.ts'))).toBe(false);
  });

  it('lists the derived wrappers with their depth', () => {
    expect(wrappers.wrappers.map((w) => `${w.depth} ${w.label}`)).toEqual([
      '1 level1 (src/lib/chain.ts:4)',
      '2 level2 (src/lib/chain.ts:8)',
      '3 level3 (src/lib/chain.ts:12)',
      '4 level4 (src/lib/chain.ts:16)',
      '5 level5 (src/lib/chain.ts:20)',
      '1 ShelfAnalytics.log (src/lib/analytics.ts:33)',
      '1 track (src/lib/analytics.ts:7)',
      '1 track (src/lib/use-shelf-analytics.ts:11)',
      '1 trackGenre (src/lib/use-shelf-analytics.ts:16)',
      '1 trackPayload (src/lib/analytics.ts:22)',
      '1 trackPicked (src/lib/analytics.ts:28)',
      '1 trackRetry (src/lib/analytics.ts:44)',
      '2 trackShelf (src/lib/analytics.ts:12)',
      '2 trackWeb (src/lib/analytics.ts:17)',
    ]);
  });

  it(`follows a chain ${MAX_DEPTH} wrappers deep and cuts off the sixth, counted`, () => {
    expect(MAX_DEPTH).toBe(5);
    const five = at(wrappers, 'src/pages/chain.ts:5');
    expect(five.via).toHaveLength(MAX_DEPTH + 1);
    expect(five.via[0]).toBe('level5 (src/lib/chain.ts:20)');
    // Negative control: the depth-6 call is the cut-off, not a site.
    expect(wrappers.events.map(site)).not.toContain('src/pages/chain.ts:6');
    expect(wrappers.wrappers.map((w) => w.label)).not.toContain('level6 (src/lib/chain.ts:24)');
    expect(wrappers.cutOffs).toBe(1);
    expect(wrappers.openWorld).toEqual([
      {
        file: 'src/pages/chain.ts',
        line: 6,
        kind: 'event-name',
        reason: expect.stringContaining('more than 5 wrappers (level6 (src/lib/chain.ts:24) >'),
      },
    ]);
  });

  it('is deterministic', () => {
    const again = scan('posthog-js/wrappers');
    const flat = (s: WrapperScan) =>
      [
        ...s.events.map((e) => `${site(e)} ${e.via.join('>')} ${e.properties.map(part).join()}`),
        ...s.wrappers.map((w) => w.label),
        ...s.openWorld.map((o) => o.reason),
      ].join('\n');
    expect(flat(again)).toBe(flat(wrappers));
  });
});

describe('followWrappers: edge shapes (T10.2)', () => {
  // The posthog-js capture entry given an added property from its third argument, so wrappers
  // carry addProperties (no shipped descriptor has one on an entry whose name is an argument).
  const labelled: Descriptor[] = descriptors.map((d) =>
    d.sdk !== 'posthog-js'
      ? d
      : {
          ...d,
          calls: d.calls.map((c) =>
            'member' in c && c.member === 'capture'
              ? { ...c, addProperties: { $label: 'args[2]' } }
              : c,
          ),
        },
  );
  const edgesScan = perMutant(() => {
    const r = createSourceProgram({
      repoRoot: join(FIXTURES, 'posthog-js/wrappers-edges'),
      source: { name: 'app', path: '.' },
      descriptors: labelled,
    });
    if (!r.ok) throw new Error(r.error);
    return followWrappers(r.value, labelled);
  });
  let edges: WrapperScan;
  beforeEach(() => {
    edges = edgesScan();
  });
  const via0 = (where: string): string | undefined => at(edges, where).via[0];
  const labels = (): string[] => edges.wrappers.map((w) => w.label);
  const add = (r: EventCall['addProperties']): string[] =>
    Object.entries(r).map(([k, v]) => `${k}=${part(v)}`);

  it('overloads: the call of a function or a method reaches the body', () => {
    expect(via0('src/pages/till.ts:30')).toBe('trackFormat (src/lib/edges.ts:7)');
    expect(via0('src/pages/till.ts:31')).toBe('Till.ring (src/lib/edges.ts:16)');
  });

  it('names a private or computed method (computed), a class expression method by itself', () => {
    expect(via0('src/lib/edges.ts:26')).toBe('Till.(computed) (src/lib/edges.ts:19)');
    expect(via0('src/pages/till.ts:32')).toBe('Till.(computed) (src/lib/edges.ts:22)');
    expect(via0('src/pages/till.ts:33')).toBe('tally (src/lib/edges.ts:32)');
  });

  it('names a function expression by its const or its own name, else (anonymous)', () => {
    expect(via0('src/pages/till.ts:34')).toBe('trackTag (src/lib/edges.ts:38)');
    expect(via0('src/pages/till.ts:35')).toBe('sendNamed (src/lib/edges.ts:41)');
    expect(via0('src/pages/till.ts:41')).toBe('(anonymous) (src/lib/default-sender.ts:4)');
    expect(via0('src/lib/edges.ts:72')).toBe('(anonymous) (src/lib/edges.ts:71)');
  });

  it('follows a string literal key read', () => {
    expect(at(edges, 'src/pages/till.ts:36').event).toEqual({ arg: 'args[0].name' });
  });

  it('does not follow a rest parameter, a rest or array pattern, a computed key or a name with no declaration', () => {
    for (const line of [52, 55, 58, 61, 66, 67])
      expect(at(edges, `src/lib/edges.ts:${line}`).via).toEqual(['PostHog.capture']);
    const sites = edges.events.map(site);
    for (const line of [37, 38, 39, 40]) expect(sites).not.toContain(`src/pages/till.ts:${line}`);
    for (const name of ['trackRest', 'trackRestPicked', 'trackFirst', 'trackComputed'])
      expect(labels().some((l) => l.startsWith(`${name} `))).toBe(false);
  });

  it('options of an outer function stay values of the inner wrapper', () => {
    expect(at(edges, 'src/pages/till.ts:42').properties.map(part)).toEqual(['opts']);
    expect(at(edges, 'src/pages/till.ts:43').properties.map(part)).toEqual([
      '{...opts}',
      "{kind: 'spread'}",
    ]);
  });

  it(`follows ${8} const aliases or property reads, not ${9}`, () => {
    expect(via0('src/pages/till.ts:44')).toBe('aliased8 (src/lib/edges.ts:88)');
    expect(at(edges, 'src/pages/till.ts:56').event).toEqual({ arg: 'args[0].k.k.k.k.k.k.k.k' });
    expect(at(edges, 'src/pages/till.ts:58').event).toEqual({ arg: 'args[0].k.k.k.k.k.k.k.k' });
    for (const line of [109, 119, 125])
      expect(at(edges, `src/lib/edges.ts:${line}`).via).toEqual(['PostHog.capture']);
    const sites = edges.events.map(site);
    for (const line of [45, 57, 59]) expect(sites).not.toContain(`src/pages/till.ts:${line}`);
  });

  it('carries added properties through wrappers: a parameter, a fixed value, none', () => {
    expect(add(at(edges, 'src/pages/till.ts:46').addProperties)).toEqual(['$label=args[1]']);
    expect(at(edges, 'src/pages/till.ts:47').via).toEqual([
      'trackOuter (src/lib/labels.ts:10)',
      'trackFixedLabel (src/lib/labels.ts:7)',
      'PostHog.capture',
    ]);
    expect(add(at(edges, 'src/pages/till.ts:47').addProperties)).toEqual([
      "$label='shelf' as any",
    ]);
    expect(add(at(edges, 'src/pages/till.ts:48').addProperties)).toEqual([]);
    expect(add(at(edges, 'src/lib/edges.ts:52').addProperties)).toEqual(['$label=args[2]']);
  });

  it('a wrapper in a skipped story file is not user code: its call is no site', () => {
    expect(edges.events.map(site)).not.toContain('src/pages/till.ts:49');
    expect(labels().some((l) => l.includes('stories'))).toBe(false);
  });

  it('two calls of the cut-off wrapper in one function give one cut-off per outside call', () => {
    expect(edges.cutOffs).toBe(1);
    expect(edges.openWorld.map((o) => `${o.file}:${o.line} ${o.kind}`)).toEqual([
      'src/pages/till.ts:51 event-name',
      'src/pages/z-untyped.ts:7 unresolved-import',
    ]);
  });

  it('orders two sites on one line by their position', () => {
    const same = edges.events.filter((e) => site(e) === 'src/pages/till.ts:52');
    expect(same.map((e) => e.call.getText())).toEqual([
      "trackTag('same_line_a')",
      "trackTag('same_line_b')",
    ]);
  });

  it('lists the wrappers sorted by their via chain', () => {
    expect(labels()).toEqual([
      '(anonymous) (src/lib/default-sender.ts:4)',
      '(anonymous) (src/lib/edges.ts:71)',
      '(anonymous) (src/lib/edges.ts:77)',
      '(anonymous) (src/lib/edges.ts:82)',
      'aliased8 (src/lib/edges.ts:88)',
      'dotted8 (src/lib/edges.ts:115)',
      'keyed8 (src/lib/edges.ts:121)',
      'level1 (src/lib/chain.ts:4)',
      'level2 (src/lib/chain.ts:7)',
      'level3 (src/lib/chain.ts:10)',
      'level4 (src/lib/chain.ts:13)',
      'level5 (src/lib/chain.ts:16)',
      'sendNamed (src/lib/edges.ts:41)',
      'tally (src/lib/edges.ts:32)',
      'Till.(computed) (src/lib/edges.ts:19)',
      'Till.(computed) (src/lib/edges.ts:22)',
      'Till.ring (src/lib/edges.ts:16)',
      'trackFixedLabel (src/lib/labels.ts:7)',
      'trackFormat (src/lib/edges.ts:7)',
      'trackKeyed (src/lib/edges.ts:46)',
      'trackLabelled (src/lib/labels.ts:4)',
      'trackOuter (src/lib/labels.ts:10)',
      'trackTag (src/lib/edges.ts:38)',
      'trackUnlabelled (src/lib/labels.ts:13)',
    ]);
  });
});

describe('valueAt on parsed calls', () => {
  const sf = ts.createSourceFile(
    'calls.ts',
    [
      "function t(a: unknown, b = 'dflt') {}",
      "t(...xs, 'x');",
      "t('a', ...xs);",
      "t({ name: 'a', name: 'b' });",
      't({ name });',
      "t({ name: 'a', ...more });",
      "t('only');",
      "t(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 'ten');",
    ].join('\n'),
    ts.ScriptTarget.Latest,
    true,
  );
  const callee = sf.statements[0] as ts.FunctionDeclaration;
  const calls = sf.statements
    .slice(1)
    .map((s) => (s as ts.ExpressionStatement).expression as ts.CallExpression);
  const text = (i: number, path: string, fn: ts.FunctionDeclaration | null = callee) => {
    const v = valueAt(calls[i] as ts.CallExpression, path, fn ?? undefined);
    return v && [v.node.getText(), ...v.keys].join(' ');
  };

  it('an argument at or after a spread has no known position', () => {
    expect(text(0, 'args[0]')).toBeUndefined();
    expect(text(0, 'args[1]')).toBeUndefined();
    expect(text(1, 'args[0]')).toBe("'a'");
    expect(text(1, 'args[1]')).toBeUndefined();
  });

  it('the last key written wins, and reading it twice gives the same answer', () => {
    expect(text(2, 'args[0].name')).toBe("'b'");
    expect(text(2, 'args[0].name')).toBe("'b'");
  });

  it('a shorthand property reads its identifier; a spread after the key stops the read', () => {
    expect(text(3, 'args[0].name')).toBe('name');
    expect(text(4, 'args[0].name')).toBe("{ name: 'a', ...more } name");
  });

  it('a left-out argument is the default, or nothing past the parameters or without the callee', () => {
    expect(text(5, 'args[1]')).toBe("'dflt'");
    expect(text(5, 'args[2]')).toBeUndefined();
    expect(text(5, 'args[1]', null)).toBeUndefined();
    expect(text(5, 'name')).toBeUndefined();
  });

  it('reads an argument index of two digits', () => {
    expect(text(6, 'args[10]')).toBe("'ten'");
    expect(text(6, 'args[1]')).toBe('1');
  });
});

describe('followWrappers: a wrapper outside the source', () => {
  it('counts the wrapper but none of the shared calls as sites', () => {
    expect(shared.events.map(site)).toEqual(['app/src/main.ts:6']);
    expect(at(shared, 'app/src/main.ts:6').via).toEqual([
      'trackShared (shared/track.ts:5)',
      'PostHog.capture',
    ]);
    expect(shared.wrappers.map((w) => w.label)).toEqual(['trackShared (shared/track.ts:5)']);
    // `register` has no event role: matched, not followed.
    expect(shared.sdkCalls.calls.map((c) => `${c.file}:${c.line} ${c.entry.member}`)).toContain(
      'app/src/main.ts:5 register',
    );
    expect(shared.cutOffs).toBe(0);
  });
});
