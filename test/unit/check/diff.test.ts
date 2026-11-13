import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DiffGitError,
  atOrAbove,
  diffCatalogs,
  diffGit,
  diffResults,
  factInputs,
  profileFor,
  readAtCommit,
  resolveCommit,
  type CatalogChange,
  type CheckContext,
  type CodeFacts,
  type CodeIndex,
  type DiffInput,
  type DiffResult,
  type FailOn,
  type GitDiffOptions,
} from '../../../src/check/index.js';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import {
  builtinTables,
  enclosingFunction,
  enclosingFunctions,
  eventFact,
  extractCatalog,
  mergeCatalogs,
  personPropertyFact,
  propertyFact,
} from '../../../src/extract/index.js';
import type { Catalog, CatalogEvent, PropertyFact } from '../../../src/formats/catalog.js';
import type { Requirements, Tile } from '../../../src/formats/requirements.js';
import { loadRequirements } from '../../../src/formats/yaml.js';

const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;
const tables = builtinTables(descriptors);
const NOW = new Date('2026-12-18T09:12:00Z');
const REQS = 'dashlint.requirements.json';

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** The check context T7.4 builds: code facts from the merged catalogs, the requirements' profile. */
function contextFor(catalogs: readonly Catalog[], requirements: Requirements): CheckContext {
  const m = mergeCatalogs(catalogs, tables);
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
    sites: (e) => (merged(e)?.sites ?? []).map((s) => ({ file: s.file, line: s.line })),
    platforms: m.platforms,
    eventPlatforms: (e) => merged(e)?.platforms ?? [],
  };
  return {
    facts: factInputs(requirements, code),
    index,
    profile: profileFor(requirements.source),
  };
}

function catalogsAt(root: string, commit: string | null): Catalog[] {
  const r = extractCatalog({
    repoRoot: root,
    source: { name: 'web', path: '.' },
    descriptors,
    tool: '0.0.0-test',
    platforms: ['web'],
    commit,
  });
  if (!r.ok) throw new Error(r.error);
  return [r.value.catalog];
}

// ---- The bookshop repo (spec 6.17) --------------------------------------------------------------

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
  },
  include: ['src'],
});

interface Shop {
  genres?: string;
  wishlistEvent?: string;
  wishlistFormat?: boolean;
  orderFormat?: boolean;
}

/** `src/shelf.ts`: the wishlist and order calls, each in its own function. */
function shelf(s: Shop = {}): string {
  const genres = s.genres ?? `'fiction' | 'poetry' | 'travel'`;
  const fmt = s.wishlistFormat === false ? '' : `, format: 'paperback'`;
  const orderProps = s.orderFormat === false ? '{}' : `{ format: 'ebook' }`;
  return [
    `import posthog from 'posthog-js';`,
    ``,
    `export function shareWishlist(genre: ${genres}): void {`,
    `  posthog.capture('${s.wishlistEvent ?? 'wishlist_shared'}', { genre_id: genre${fmt} });`,
    `}`,
    ``,
    `export function completeOrder(): void {`,
    `  posthog.capture('order_completed', ${orderProps});`,
    `}`,
    ``,
  ].join('\n');
}

const ev = (event: string, filters: Tile['filters'] = []) => ({
  ref: 'A',
  node: 'event' as const,
  event,
  ...(filters.length > 0 ? { filters } : {}),
});
const exact = (key: string, value: string) => ({
  key,
  scope: 'event' as const,
  op: 'exact',
  values: [value],
});

const TILES: Tile[] = [
  {
    id: 'insight:Wish01',
    title: 'Wishlist shares, fiction',
    kind: 'trends',
    series: [ev('wishlist_shared', [exact('genre_id', 'fiction')])],
  },
  {
    id: 'insight:Wish02',
    title: 'Paperback wishlists',
    kind: 'trends',
    series: [ev('wishlist_shared', [exact('format', 'paperback')])],
  },
  {
    id: 'insight:Ord03',
    title: 'Orders by format',
    kind: 'trends',
    series: [ev('order_completed')],
    breakdown: [{ key: 'format', scope: 'event' }],
  },
  {
    id: 'insight:Gift04',
    title: 'Gift cards redeemed',
    kind: 'trends',
    series: [ev('gift_card_redeemed')],
  },
];

function requirements(tiles: Tile[] = TILES): Requirements {
  return { schema: 'dashlint.requirements/1', source: { platform: 'posthog' }, tiles };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', repo, '-c', 'user.name=Shop', '-c', 'user.email=shop@example.invalid', ...args],
    { encoding: 'utf8', stdio: 'pipe' },
  ).trim();
}

function write(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

function commit(repo: string, message: string, files: Record<string, string>): string {
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A repo with the base commit, then the head commit; returns the repo and both commits. */
function repo(
  head: Record<string, string>,
  base: Record<string, string> = {},
): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dashlint-diff-test-'));
  temps.push(root);
  git(root, 'init', '-q', '-b', 'main');
  const b = commit(root, 'base', {
    'tsconfig.json': TSCONFIG,
    'src/shelf.ts': shelf(),
    [REQS]: JSON.stringify(requirements(), null, 2),
    ...base,
  });
  const h = commit(root, 'head', head);
  return { root, base: b, head: h };
}

function headRequirements(root: string, commit: string): Requirements {
  const r = loadRequirements(readAtCommit(root, commit, REQS) as string);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

function run(
  r: { root: string; base: string; head: string },
  extra: Partial<GitDiffOptions> = {},
): DiffResult {
  return diffGit({
    repoRoot: r.root,
    base: r.base,
    head: r.head,
    requirements: headRequirements(r.root, r.head),
    requirementsPath: REQS,
    catalogsAt,
    enclosingIn: enclosingFunctions,
    contextFor,
    failOn: 'dead',
    now: NOW,
    ...extra,
  });
}

const changeIds = (cs: { id: string; base: string; head: string; fails: boolean }[]) =>
  cs.map((c) => [c.id, c.base, c.head, c.fails]);

// Two extractions per test, slow under coverage while other files run (T7.6): 30 s, not 5.
describe('diff over git worktrees (spec 6.7.5)', { timeout: 30_000 }, () => {
  it('rename: the event renamed in the same function newly breaks its tiles and fails', () => {
    const r = repo({ 'src/shelf.ts': shelf({ wishlistEvent: 'wishlist_sent' }) });
    const d = run(r);
    expect(changeIds(d.worse)).toEqual([
      ['insight:Wish01', 'live', 'dead', true],
      ['insight:Wish02', 'live', 'dead', true],
    ]);
    expect(d.catalog).toEqual([
      {
        kind: 'event-renamed',
        from: 'wishlist_shared',
        to: 'wishlist_sent',
        function: 'shareWishlist',
        sites: [{ source: 'web', file: 'src/shelf.ts', line: 4 }],
      },
    ]);
    expect(d).toMatchObject({
      fails: true,
      fixed: [],
      changed: [],
      base: { commit: r.base },
      head: { commit: r.head },
      requirements: { status: 'unchanged', tiles: [] },
    });
  });

  it('removed property: the filter on it goes dead and fails; the breakdown degrades', () => {
    const r = repo({ 'src/shelf.ts': shelf({ wishlistFormat: false, orderFormat: false }) });
    const d = run(r);
    expect(changeIds(d.worse)).toEqual([
      ['insight:Wish02', 'live', 'dead', true],
      ['insight:Ord03', 'live', 'degraded', false],
    ]);
    expect(d.catalog).toEqual([
      { kind: 'property-removed', event: 'order_completed', property: 'format' },
      { kind: 'property-removed', event: 'wishlist_shared', property: 'format' },
    ]);
    expect(d.fails).toBe(true);
    // At failOn degraded the breakdown fails too (failing tiles first, then by id).
    expect(changeIds(run(r, { failOn: 'degraded' }).worse)).toEqual([
      ['insight:Ord03', 'live', 'degraded', true],
      ['insight:Wish02', 'live', 'dead', true],
    ]);
  });

  it('narrowed values: the filter value no longer reachable is dead and fails', () => {
    const r = repo({ 'src/shelf.ts': shelf({ genres: `'poetry' | 'travel'` }) });
    const d = run(r);
    expect(changeIds(d.worse)).toEqual([['insight:Wish01', 'live', 'dead', true]]);
    expect(d.catalog).toEqual([
      {
        kind: 'values-narrowed',
        event: 'wishlist_shared',
        property: 'genre_id',
        removed: ['fiction'],
      },
    ]);
  });

  it('negative control: a tile already dead on the base never fails the diff', () => {
    const r = repo({ 'README.md': 'The bookshop.\n' });
    const d = run(r);
    expect(d).toMatchObject({
      fails: false,
      worse: [],
      fixed: [],
      changed: [],
      alreadyBroken: 1,
      catalog: [],
    });
    // Still dead, and another tile broken by the change: only that one fails.
    const r2 = repo({ 'src/shelf.ts': shelf({ genres: `'poetry'` }) });
    const d2 = run(r2);
    expect(d2.alreadyBroken).toBe(1);
    expect(changeIds(d2.worse)).toEqual([['insight:Wish01', 'live', 'dead', true]]);
    expect(d2.worse.some((c) => c.id === 'insight:Gift04')).toBe(false);
  });

  it('requirements changed in the same PR: the changes they cause are information only', () => {
    const tiles: Tile[] = [
      // Edited: now asks for a value the code never sends.
      { ...(TILES[0] as Tile), series: [ev('wishlist_shared', [exact('genre_id', 'cookery')])] },
      ...TILES.slice(1, 3),
      // Added: queries an event no code sends.
      { id: 'insight:Rev05', title: 'Reviews', kind: 'trends', series: [ev('review_submitted')] },
    ];
    const r = repo({ [REQS]: JSON.stringify(requirements(tiles), null, 2) });
    const d = run(r);
    expect(d).toMatchObject({ fails: false, worse: [], fixed: [], changed: [], catalog: [] });
    expect(d.requirements).toEqual({
      status: 'changed',
      tiles: [
        { id: 'insight:Gift04', title: 'Gift cards redeemed', change: 'removed', before: 'dead' },
        { id: 'insight:Rev05', title: 'Reviews', change: 'added', after: 'dead' },
        {
          id: 'insight:Wish01',
          title: 'Wishlist shares, fiction',
          change: 'changed',
          before: 'live',
          after: 'dead',
        },
      ],
    });
    // Both at once: the code change still fails, the requirements change still does not.
    const r2 = repo({
      [REQS]: JSON.stringify(requirements(tiles), null, 2),
      'src/shelf.ts': shelf({ wishlistFormat: false }),
    });
    const d2 = run(r2);
    expect(changeIds(d2.worse)).toEqual([['insight:Wish02', 'live', 'dead', true]]);
    expect(d2.requirements.tiles.map((t) => t.id)).toEqual([
      'insight:Gift04',
      'insight:Rev05',
      'insight:Wish01',
    ]);
  });

  it('a base with no requirements file is "new"; one that does not load is "unknown"', () => {
    const r = repo({ [REQS]: JSON.stringify(requirements(), null, 2) }, { [REQS]: '' });
    git(r.root, 'rm', '-q', REQS);
    const noFile = commit(r.root, 'base without requirements', {});
    const head = commit(r.root, 'head', { [REQS]: JSON.stringify(requirements(), null, 2) });
    expect(run({ root: r.root, base: noFile, head }).requirements).toEqual({
      status: 'new',
      tiles: [],
    });
    const bad = repo({ [REQS]: JSON.stringify(requirements(), null, 2) }, { [REQS]: '{ "a": 1 }' });
    expect(run(bad).requirements).toEqual({ status: 'unknown', tiles: [] });
  });

  it('fixed tiles are listed and never fail; an ignored tile is counted, not compared', () => {
    const r = repo(
      { 'src/shelf.ts': shelf() },
      { 'src/shelf.ts': shelf({ wishlistFormat: false }) },
    );
    const d = run(r);
    expect(changeIds(d.fixed)).toEqual([['insight:Wish02', 'dead', 'live', false]]);
    expect(d.fails).toBe(false);
    const r2 = repo({ 'src/shelf.ts': shelf({ wishlistEvent: 'wishlist_sent' }) });
    const d2 = run(r2, { ignore: [{ kind: 'tile', id: 'insight:Wish01', reason: 'retired' }] });
    expect(d2.ignored).toBe(1);
    expect(changeIds(d2.worse)).toEqual([['insight:Wish02', 'live', 'dead', true]]);
    // An expired entry warns and the tile is compared again.
    const d3 = run(r2, {
      ignore: [{ kind: 'tile', id: 'insight:Wish01', reason: 'retired', until: '2026-12-01' }],
    });
    expect(d3.ignored).toBe(0);
    expect(d3.worse).toHaveLength(2);
    expect(d3.warnings.map((w) => w.code)).toEqual(['ignore-expired']);
  });

  it('no head ref: the working tree is the head, uncommitted changes included', () => {
    const r = repo({ 'README.md': 'The bookshop.\n' });
    write(r.root, { 'src/shelf.ts': shelf({ wishlistEvent: 'wishlist_sent' }) });
    const opts: Partial<GitDiffOptions> = { requirements: requirements() };
    const d = diffGit({
      repoRoot: r.root,
      base: 'HEAD~1',
      requirements: requirements(),
      requirementsPath: REQS,
      catalogsAt,
      enclosingIn: enclosingFunctions,
      contextFor,
      failOn: 'dead',
      now: NOW,
      ...opts,
    });
    expect(d.head.commit).toBeNull();
    expect(d.base.commit).toBe(r.base);
    expect(d.fails).toBe(true);
    expect(d.catalog.map((c) => c.kind)).toEqual(['event-renamed']);
    // With a head ref the committed head is read, not the edited working tree.
    const committed = run(r);
    expect(committed).toMatchObject({ fails: false, catalog: [], head: { commit: r.head } });
  });

  it('removes its worktrees, and refuses a ref that is not a commit', () => {
    const r = repo({ 'src/shelf.ts': shelf({ wishlistEvent: 'wishlist_sent' }) });
    run(r);
    expect(git(r.root, 'worktree', 'list').split('\n')).toHaveLength(1);
    const left = readdirSync(realpathSync(tmpdir())).filter((n) => n.startsWith('dashlint-base-'));
    expect(run(r).fails).toBe(true);
    expect(
      readdirSync(realpathSync(tmpdir())).filter((n) => n.startsWith('dashlint-base-')),
    ).toEqual(left);
    expect(() => run(r, { base: 'no-such-branch' })).toThrow(DiffGitError);
    expect(() => resolveCommit(r.root, '--help')).toThrow(DiffGitError);
    // A failing catalog builder still leaves no worktree behind.
    expect(() =>
      run(r, {
        catalogsAt: () => {
          throw new Error('extract failed');
        },
      }),
    ).toThrow('extract failed');
    expect(git(r.root, 'worktree', 'list').split('\n')).toHaveLength(1);
  });
});

// ---- Thresholds and the change list, on synthetic catalogs ------------------------------------

const always = (set: string[]): PropertyFact => ({
  presence: 'always',
  values: { kind: 'finite', set },
});

function event(line: number, properties: Record<string, PropertyFact> = {}): CatalogEvent {
  return {
    sites: [
      {
        file: 'src/shop.ts',
        line,
        sdk: 'posthog-js',
        via: [],
        platforms: ['web'],
        openProperties: false,
      },
    ],
    openSites: 0,
    properties,
  };
}

function catalog(events: Record<string, CatalogEvent>, extra: Partial<Catalog> = {}): Catalog {
  return {
    schema: 'dashlint.catalog/1',
    tool: '0.0.0-test',
    source: { name: 'web', root: '.', commit: null, platforms: ['web'], sdks: [] },
    openWorld: [],
    events,
    superProperties: {},
    personProperties: {},
    builtins: { events: [], properties: null, conditional: [], off: [] },
    identity: [],
    coverage: {
      files: 1,
      excludedFiles: 0,
      callSites: 2,
      literalNameSites: 2,
      openSites: 0,
      nameResolutionRate: 1,
      openSuperSites: 0,
    },
    ...extra,
  };
}

const funnelTile: Tile = {
  id: 'insight:Fun06',
  title: 'Checkout',
  kind: 'funnels',
  series: [ev('cart_viewed'), { ...ev('order_completed'), ref: 'B' }],
};

function synthetic(
  base: Catalog,
  head: Catalog,
  failOn: FailOn,
  tiles: Tile[] = [funnelTile],
): DiffResult {
  const input: DiffInput = {
    requirements: requirements(tiles),
    base: { catalogs: [base], commit: 'b' },
    head: { catalogs: [head], commit: 'h' },
    contextFor,
    failOn,
    now: NOW,
  };
  return diffResults(input);
}

describe('failOn and newly broken (D5)', () => {
  const both = catalog({ cart_viewed: event(3), order_completed: event(9) });
  const firstOnly = catalog({ cart_viewed: event(3) });
  const none = catalog({});

  it('live to partly dead fails at partly-dead and degraded, not at dead or never', () => {
    expect(synthetic(both, firstOnly, 'partly-dead').fails).toBe(true);
    expect(synthetic(both, firstOnly, 'degraded').fails).toBe(true);
    expect(synthetic(both, firstOnly, 'dead').fails).toBe(false);
    expect(synthetic(both, firstOnly, 'never').fails).toBe(false);
    expect(changeIds(synthetic(both, firstOnly, 'dead').worse)).toEqual([
      ['insight:Fun06', 'live', 'partly-dead', false],
    ]);
  });

  it('partly dead to dead fails at dead; at partly-dead it was broken already and only counts', () => {
    expect(changeIds(synthetic(firstOnly, none, 'dead').worse)).toEqual([
      ['insight:Fun06', 'partly-dead', 'dead', true],
    ]);
    const d = synthetic(firstOnly, none, 'partly-dead');
    expect(changeIds(d.worse)).toEqual([['insight:Fun06', 'partly-dead', 'dead', false]]);
    expect(d).toMatchObject({ fails: false, alreadyBroken: 1 });
  });

  it('not checked on the base, dead on the head: worse, never a failure', () => {
    const low = catalog(
      { cart_viewed: event(3), order_completed: event(9) },
      {
        coverage: {
          files: 1,
          excludedFiles: 0,
          callSites: 10,
          literalNameSites: 5,
          openSites: 5,
          nameResolutionRate: 0.5,
          openSuperSites: 0,
        },
      },
    );
    const t: Tile = {
      id: 'insight:Gift04',
      title: 'Gift',
      kind: 'trends',
      series: [ev('gift_card_redeemed')],
    };
    const d = synthetic(low, both, 'dead', [t]);
    expect(changeIds(d.worse)).toEqual([['insight:Gift04', 'not-checked', 'dead', false]]);
    expect(d.fails).toBe(false);
    // The other way round it is a change, neither worse nor fixed.
    const back = synthetic(both, low, 'dead', [t]);
    expect(changeIds(back.changed)).toEqual([['insight:Gift04', 'dead', 'not-checked', false]]);
  });

  it('atOrAbove ranks only decided verdicts', () => {
    expect(atOrAbove('dead', 'dead')).toBe(true);
    expect(atOrAbove('partly-dead', 'dead')).toBe(false);
    expect(atOrAbove('degraded', 'degraded')).toBe(true);
    expect(atOrAbove('one-platform', 'degraded')).toBe(false);
    expect(atOrAbove('not-checked', 'degraded')).toBe(false);
    expect(atOrAbove('ignored', 'degraded')).toBe(false);
    expect(atOrAbove('dead', 'never')).toBe(false);
  });

  it('a base catalog file (no base requirements) leaves the requirements status unknown', () => {
    expect(synthetic(both, both, 'dead').requirements).toEqual({ status: 'unknown', tiles: [] });
  });
});

describe('alert changes', () => {
  it('an alert on a series that goes dead can never fire: worse; back again: fixed', () => {
    const t: Tile = {
      id: 'insight:Ord03',
      title: 'Orders',
      kind: 'trends',
      series: [ev('order_completed')],
    };
    const reqs: Requirements = {
      ...requirements([t]),
      alerts: [
        {
          id: 'alert:a1',
          name: 'Orders dropped',
          tile: 'insight:Ord03',
          target: { kind: 'series', index: 0 },
          condition: 'absolute_value',
          bounds: { lower: false, upper: true },
        },
      ],
    };
    const live = catalog({ order_completed: event(9) });
    const dead = catalog({});
    const go = (base: Catalog, head: Catalog, ignore: DiffInput['ignore'] = []) =>
      diffResults({
        requirements: reqs,
        base: { catalogs: [base], commit: null },
        head: { catalogs: [head], commit: null },
        contextFor,
        failOn: 'dead',
        ignore,
        now: NOW,
      }).alerts;
    expect(go(live, dead)).toEqual({
      worse: [
        {
          id: 'alert:a1',
          name: 'Orders dropped',
          tile: 'insight:Ord03',
          base: 'ok',
          head: 'can-never-fire',
        },
      ],
      fixed: [],
    });
    expect(go(dead, live).fixed.map((a) => a.id)).toEqual(['alert:a1']);
    expect(go(live, live)).toEqual({ worse: [], fixed: [] });
    expect(go(live, dead, [{ kind: 'alert', id: 'alert:a1', reason: 'r' }]).worse).toEqual([]);
  });
});

describe('diffCatalogs (spec 6.7.5 change list)', () => {
  const at = (map: Record<string, string>) => (file: string, line: number) =>
    map[`${file}:${String(line)}`] ?? null;

  it('removed and added without a shared function stay removed and added', () => {
    const base = catalog({ wishlist_shared: event(4) });
    const head = catalog({ wishlist_sent: event(4) });
    const cs = diffCatalogs([base], [head], {
      base: at({ 'src/shop.ts:4': 'share' }),
      head: at({ 'src/shop.ts:4': 'send' }),
    });
    expect(cs.map((c) => c.kind)).toEqual(['event-removed', 'event-added']);
    // Without the enclosing lookups nothing is called renamed.
    expect(diffCatalogs([base], [head]).map((c) => c.kind)).toEqual([
      'event-removed',
      'event-added',
    ]);
  });

  it('a rename needs a one-to-one match', () => {
    const base = catalog({ a_old: event(4), b_old: event(5) });
    const head = catalog({ a_new: event(4) });
    const fn = at({ 'src/shop.ts:4': 'share', 'src/shop.ts:5': 'share' });
    // Two removed events share the function with one added event: no rename.
    expect(diffCatalogs([base], [head], { base: fn, head: fn }).map((c) => c.kind)).toEqual([
      'event-removed',
      'event-removed',
      'event-added',
    ]);
    const head2 = catalog({ a_new: event(4), c_new: event(5) });
    // One removed event, two added in the same function: no rename either.
    expect(
      diffCatalogs([catalog({ a_old: event(4) })], [head2], { base: fn, head: fn }).map(
        (c) => c.kind,
      ),
    ).toEqual(['event-removed', 'event-added', 'event-added']);
    // A site at module top level has no function.
    const none = at({});
    expect(
      diffCatalogs([catalog({ a_old: event(4) })], [head], { base: none, head: none }).map(
        (c) => c.kind,
      ),
    ).toEqual(['event-removed', 'event-added']);
  });

  it('a renamed event carries its property changes', () => {
    const base = catalog({
      a_old: event(4, { genre_id: always(['fiction', 'poetry']), shelf: always(['x']) }),
    });
    const head = catalog({ a_new: event(4, { genre_id: always(['poetry']) }) });
    const fn = at({ 'src/shop.ts:4': 'share' });
    const cs: CatalogChange[] = diffCatalogs([base], [head], { base: fn, head: fn });
    expect(cs).toEqual([
      {
        kind: 'event-renamed',
        from: 'a_old',
        to: 'a_new',
        function: 'share',
        sites: [{ source: 'web', file: 'src/shop.ts', line: 4 }],
      },
      { kind: 'values-narrowed', event: 'a_new', property: 'genre_id', removed: ['fiction'] },
      { kind: 'property-removed', event: 'a_new', property: 'shelf' },
    ]);
  });

  it('an open head makes no removed claim; widened or open values are not narrowed', () => {
    const base = catalog({ e: event(4, { k: always(['a']), w: always(['a']), o: always(['a']) }) });
    const openEvent = { ...event(4, {}), openSites: 1 };
    expect(diffCatalogs([base], [catalog({ e: openEvent })])).toEqual([]);
    const crashed = catalog(
      { e: event(4, {}) },
      {
        coverage: { ...catalog({}).coverage, crashedFiles: 1 },
      },
    );
    expect(diffCatalogs([base], [crashed])).toEqual([]);
    const head = catalog({
      e: event(4, {
        k: always(['a']),
        w: always(['a', 'b']),
        o: { presence: 'always', values: { kind: 'open', type: 'string' } },
      }),
    });
    expect(diffCatalogs([base], [head])).toEqual([]);
  });

  it('super properties: removed and narrowed with event null; an open super site blocks removed', () => {
    const sup = (set: string[]) => ({
      ...always(set),
      sites: [{ file: 'src/boot.ts', line: 2, call: 'register' }],
    });
    const base = catalog(
      {},
      { superProperties: { plan: sup(['free', 'pro']), theme: sup(['dark']) } },
    );
    const head = catalog({}, { superProperties: { plan: sup(['pro']) } });
    expect(diffCatalogs([base], [head])).toEqual([
      { kind: 'values-narrowed', event: null, property: 'plan', removed: ['free'] },
      { kind: 'property-removed', event: null, property: 'theme' },
    ]);
    const open = catalog(
      {},
      {
        superProperties: { plan: sup(['pro']) },
        coverage: { ...catalog({}).coverage, openSuperSites: 1 },
      },
    );
    expect(diffCatalogs([base], [open])).toEqual([
      { kind: 'values-narrowed', event: null, property: 'plan', removed: ['free'] },
    ]);
    // A key moved from the event call to a super property is still sent on the event.
    const moved = catalog({ e: event(4) }, { superProperties: { shelf: sup(['x']) } });
    expect(
      diffCatalogs(
        [catalog({ e: event(4, { shelf: always(['x']), gone: always(['y']) }) })],
        [moved],
      ),
    ).toEqual([{ kind: 'property-removed', event: 'e', property: 'gone' }]);
  });

  it('values merge across sources: one source still sending a value keeps it', () => {
    const web = catalog({ e: event(4, { k: always(['a', 'b']) }) });
    const ios = {
      ...catalog({ e: event(7, { k: always(['a']) }) }),
      source: { ...web.source, name: 'ios' },
    };
    const iosB = {
      ...catalog({ e: event(7, { k: always(['b']) }) }),
      source: { ...web.source, name: 'ios' },
    };
    expect(diffCatalogs([web], [ios, iosB])).toEqual([]);
    expect(diffCatalogs([web], [ios])).toEqual([
      { kind: 'values-narrowed', event: 'e', property: 'k', removed: ['b'] },
    ]);
  });
});

describe('enclosingFunction', () => {
  const text = [
    `import posthog from 'posthog-js';`, // 1
    `posthog.capture('top_level');`, // 2
    `export function shareWishlist(): void {`, // 3
    `  posthog.capture('wishlist_shared');`, // 4
    `  [1].forEach(() => posthog.capture('inner'));`, // 5
    `}`, // 6
    `export const share = () => {`, // 7
    `  posthog.capture('arrow');`, // 8
    `};`, // 9
    `class Shelf {`, // 10
    `  open() { posthog.capture('method'); }`, // 11
    `  constructor() { posthog.capture('ctor'); }`, // 12
    `  get size() { return 1; }`, // 13
    `}`, // 14
    `const handlers = { onShare: function () { posthog.capture('prop'); } };`, // 15
    `const f = function named() { posthog.capture('named'); };`, // 16
    `const Anon = class { run = () => posthog.capture('field'); };`, // 17
    `   `, // 18
  ].join('\n');

  it('names the function by its containers; null at top level, on blank lines and past the end', () => {
    const at = (line: number) => enclosingFunction(text, 'src/shop.ts', line);
    expect([2, 4, 5, 8, 11, 12, 13, 15, 16, 17, 18, 99, 0].map(at)).toEqual([
      null,
      'shareWishlist',
      'shareWishlist.(anonymous)',
      'share',
      'Shelf.open',
      'Shelf.constructor',
      'Shelf.size',
      'onShare',
      'named',
      'Anon.run',
      null,
      null,
      null,
    ]);
    expect(at(10)).toBeNull();
  });

  it('reads tsx and js, and gives null for a file it cannot read', () => {
    expect(enclosingFunction('function A() {\n  return <b />;\n}\n', 'src/a.tsx', 2)).toBe('A');
    expect(enclosingFunction('function A() {\n  return <b />;\n}\n', 'src/a.jsx', 2)).toBe('A');
    expect(enclosingFunction('function B() {\n  go();\n}\n', 'src/b.mjs', 2)).toBe('B');
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'dashlint-enc-test-'));
    temps.push(root);
    write(root, { 'src/a.ts': 'function A() {\n  go();\n}\n' });
    const at = enclosingFunctions(root);
    expect(at('src/a.ts', 2)).toBe('A');
    expect(at('src/a.ts', 1)).toBe('A');
    expect(at('src/missing.ts', 1)).toBeNull();
    expect(at('src/missing.ts', 2)).toBeNull();
  });
});
