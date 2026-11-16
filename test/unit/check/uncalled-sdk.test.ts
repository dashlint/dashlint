// ADR-069: a source whose package.json declares an SDK package with no call of it found cannot make
// an event dead from code alone; the tile is "not checked" with a reason naming the package. A
// source that calls the SDK once, or that declares no SDK, keeps today's verdicts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { eventFacts } from '../../../src/check/facts.js';
import { applyIgnore, checkAlerts, checkContext, checkTiles } from '../../../src/check/index.js';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import { extractCatalog } from '../../../src/extract/catalog.js';
import { builtinTables, eventFact, mergeCatalogs } from '../../../src/extract/merge.js';
import { declaredPackages } from '../../../src/extract/program.js';
import type { Catalog } from '../../../src/formats/catalog.js';
import type { Requirements } from '../../../src/formats/requirements.js';
import { validateRequirements } from '../../../src/formats/validate.js';
import { reasonText } from '../../../src/report/messages.js';
import { buildReport } from '../../../src/report/index.js';
import { NOW } from '../../fixtures/report/bookshop.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;

function catalogOf(repo: string): Catalog {
  const r = extractCatalog({
    repoRoot: join(FIXTURES, repo),
    source: { name: 'web', path: '.' },
    descriptors,
    tool: '0.0.0-test',
    platforms: ['web'],
    commit: null,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value.catalog;
}

function requirements(event: string): Requirements {
  const r: Requirements = {
    schema: 'dashlint.requirements/1',
    source: { platform: 'posthog', project: 12345, tool: '0.1.0' },
    dashboards: [{ id: 'dashboard:41', name: 'Bookshop growth' }],
    tiles: [
      {
        id: 'insight:Bp08',
        title: 'Books previewed',
        dashboards: ['dashboard:41'],
        kind: 'trends',
        series: [{ node: 'event', event, ref: 'A' }],
      },
    ],
    alerts: [],
  };
  const v = validateRequirements(r);
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return r;
}

const TABLES = builtinTables(descriptors);

function check(catalogs: Catalog[], req: Requirements) {
  const ctx = checkContext(catalogs, req, TABLES);
  const outcome = applyIgnore(req, checkTiles(ctx, req), checkAlerts(ctx, req), [], NOW);
  return buildReport({ tool: '0.1.0', mode: 'check', requirements: req, catalogs, ctx, outcome });
}

function tileOf(repo: string, event: string) {
  const model = check([catalogOf(repo)], requirements(event));
  const tile = model.report.tiles[0];
  if (!tile) throw new Error('no tile');
  return tile;
}

const FAMILIES = [
  { family: 'posthog-js', pkg: 'posthog-js', unseen: 'book_previewed' },
  { family: 'segment-analytics-next', pkg: '@segment/analytics-next', unseen: 'Book Previewed' },
] as const;

describe.each(FAMILIES)('ADR-069 on $family', ({ family, pkg, unseen }) => {
  it('records the declared package with no call in the catalog', () => {
    expect(catalogOf(`${family}/uncalled`).source.uncalledSdks).toEqual([pkg]);
  });

  it('a declared package with no call site gives "not checked" naming the package', () => {
    const tile = tileOf(`${family}/uncalled`, unseen);
    expect(tile.verdict).toBe('not-checked');
    expect(tile.unknownParts.map((p) => p.reason)).toEqual([
      `the source depends on ${pkg}, but no call site of it was found`,
    ]);
  });

  it('the same source with one call site of another event gives "dead" as today', () => {
    const catalog = catalogOf(`${family}/uncalled-one-site`);
    expect(catalog.source.uncalledSdks).toBeUndefined();
    expect(catalog.coverage.callSites).toBeGreaterThan(0);
    expect(tileOf(`${family}/uncalled-one-site`, unseen).verdict).toBe('dead');
  });

  it('a source with no SDK dependency and no call site keeps today\'s "dead"', () => {
    const catalog = catalogOf(`${family}/no-dependency`);
    expect(catalog.source.uncalledSdks).toBeUndefined();
    expect(catalog.coverage.callSites).toBe(0);
    expect(tileOf(`${family}/no-dependency`, unseen).verdict).toBe('dead');
  });

  it('observed data still decides: an event PostHog saw is live', () => {
    const req = requirements(unseen);
    req.source.pulledAt = '2026-12-18T09:12:00Z';
    req.observed = {
      windowDays: 30,
      events: { [unseen]: { defined: true, lastSeenAt: '2026-12-17T08:00:00Z' } },
    };
    const model = check([catalogOf(`${family}/uncalled`)], req);
    expect(model.report.tiles[0]?.verdict).toBe('live');
  });
});

describe('ADR-069 guard', () => {
  it('the merge gives "unknown" with the package for every source that declares it', () => {
    const m = mergeCatalogs([catalogOf('posthog-js/uncalled')], TABLES);
    expect(eventFact(m, 'book_previewed')).toEqual({
      fact: 'unknown',
      unknown: ['no-call-site:posthog-js'],
      platforms: [],
    });
  });

  it('a merged source that calls the SDK does not lift the guard of one that does not', () => {
    const m = mergeCatalogs(
      [catalogOf('posthog-js/uncalled-one-site'), catalogOf('posthog-js/uncalled')],
      TABLES,
    );
    expect(eventFact(m, 'book_previewed').fact).toBe('unknown');
    expect(eventFact(m, 'basket_added').fact).toBe('yes');
  });

  it('check applies it again to a code fact provider that says "no"', () => {
    const facts = eventFacts(
      {
        code: {
          event: () => ({ fact: 'no', unknown: [] }),
          property: () => ({ fact: 'unknown', unknown: [] }),
          personProperty: () => ({ fact: 'unknown', unknown: [] }),
          nameResolutionRates: [1],
          uncalledSdks: ['posthog-js'],
        },
      },
      'book_previewed',
    );
    expect(facts).toEqual({
      code: 'unknown',
      observed: 'unknown',
      status: 'not-checked',
      reasons: ['no-call-site:posthog-js'],
    });
  });

  it('without the guard the same provider gives dead', () => {
    const facts = eventFacts(
      {
        code: {
          event: () => ({ fact: 'no', unknown: [] }),
          property: () => ({ fact: 'unknown', unknown: [] }),
          personProperty: () => ({ fact: 'unknown', unknown: [] }),
          nameResolutionRates: [1],
          uncalledSdks: [],
        },
      },
      'book_previewed',
    );
    expect(facts.status).toBe('dead');
  });

  it('a bare reason head is printed as it is', () => {
    expect(reasonText('no-call-site:')).toBe('no-call-site:');
  });
});

describe('declaredPackages', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashlint-declared-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, text: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write(
    'package.json',
    JSON.stringify({
      devDependencies: { 'posthog-js': '1' },
      peerDependencies: { '@segment/analytics-next': '1' },
    }),
  );
  write('apps/web/src/main.ts', '');
  write(
    'apps/shop/package.json',
    JSON.stringify({ optionalDependencies: { 'mixpanel-browser': '2' } }),
  );
  write('apps/broken/package.json', '{ not json');
  write('apps/empty/package.json', 'null');
  const wanted = ['posthog-js', '@segment/analytics-next', 'mixpanel-browser'];

  it('reads the nearest package.json above the source, every dependency field', () => {
    expect(declaredPackages(join(root, 'apps/web/src'), root, wanted)).toEqual([
      '@segment/analytics-next',
      'posthog-js',
    ]);
  });

  it('a nearer package.json shadows the root one', () => {
    expect(declaredPackages(join(root, 'apps/shop'), root, wanted)).toEqual(['mixpanel-browser']);
  });

  it('an unreadable or empty manifest declares nothing', () => {
    expect(declaredPackages(join(root, 'apps/broken'), root, wanted)).toEqual([]);
    expect(declaredPackages(join(root, 'apps/empty'), root, wanted)).toEqual([]);
  });

  it('never reads a package.json above the repository root', () => {
    expect(declaredPackages(join(root, 'apps/web'), join(root, 'apps/web'), wanted)).toEqual([]);
  });
});
