import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import {
  createSourceProgram,
  extractCatalog,
  findSdkCalls,
  MAX_NESTING,
  nestsDeeper,
  resolveBuiltins,
  resolveSuperProperties,
  writeCatalog,
  type ExtractInput,
  type Extracted,
} from '../../../src/extract/index.js';
import type { Catalog } from '../../../src/formats/catalog.js';
import { validateCatalog } from '../../../src/formats/validate.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function input(repo: string, extra: Partial<ExtractInput> = {}): ExtractInput {
  return {
    repoRoot: join(FIXTURES, repo),
    source: { name: 'app', path: '.' },
    descriptors,
    tool: '0.0.0-test',
    platforms: repo.startsWith('posthog-react-native/') ? ['ios', 'android'] : ['web'],
    commit: null,
    ...extra,
  };
}

function extract(repo: string, extra: Partial<ExtractInput> = {}): Extracted {
  const r = extractCatalog(input(repo, extra));
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Every extract fixture: `<sdk>/<case>`. */
const REPOS = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((sdk) => sdk.isDirectory())
  .flatMap((sdk) =>
    readdirSync(join(FIXTURES, sdk.name), { withFileTypes: true })
      .filter((c) => c.isDirectory())
      .map((c) => `${sdk.name}/${c.name}`),
  );

/** Code files of a fixture repo, its own (not node_modules). */
function codeFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f) && !f.split(/[\\/]/).includes('node_modules'))
    .map((f) => join(dir, f));
}

/**
 * The source lines of `files` that appear in any string of the catalog (keys or values). A line
 * counts when it looks like code: at least 12 characters with a call, assignment or brace; a
 * trailing `;` or `,` is dropped, so a quoted call expression is found too.
 */
function sourceTextIn(catalog: unknown, files: readonly string[]): string[] {
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null)
      for (const [k, item] of Object.entries(v)) {
        strings.push(k);
        walk(item);
      }
  };
  walk(catalog);
  const hits = new Set<string>();
  for (const file of files) {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim().replace(/[;,]$/, '');
      if (line.length < 12 || !/[(={]/.test(line)) continue;
      if (strings.some((s) => s.includes(line))) hits.add(line);
    }
  }
  return [...hits];
}

describe('extractCatalog: crash guard', () => {
  const crash = extract('posthog-js/crash');
  const c = crash.catalog;

  it('counts the file nested too deep to analyse, and the file the parse overflows on, as unknown', () => {
    expect(c.coverage.crashedFiles).toBe(2);
    expect(c.openWorld.filter((o) => o.kind === 'file-error')).toEqual([
      {
        file: 'src/deep-chain.ts',
        line: 1,
        kind: 'file-error',
        reason: `the file nests deeper than ${MAX_NESTING} levels; its calls are unknown`,
      },
      {
        file: 'src/deep-parse.ts',
        line: 1,
        kind: 'file-error',
        reason: 'TypeScript could not parse this file (RangeError); its calls are unknown',
      },
    ]);
  });

  it('goes on with the other files and gives no site from the crashed ones', () => {
    expect(Object.keys(c.events)).toEqual(['reader_opened', 'wishlist_shared']);
    expect(c.events.wishlist_shared?.sites).toEqual([
      {
        file: 'src/shelf.ts',
        line: 4,
        sdk: 'posthog-js',
        via: ['PostHog.capture'],
        platforms: ['web'],
        openProperties: false,
      },
    ]);
    expect(c.coverage.files).toBe(2);
  });

  it('counts each crashed file as one open call site, so no event is certain to be absent', () => {
    expect(c.coverage).toMatchObject({
      callSites: 4,
      literalNameSites: 2,
      openSites: 2,
      nameResolutionRate: 0.5,
    });
  });

  it('returns the errors as warnings, never in the catalog', () => {
    expect(crash.warnings.filter((w) => w.includes('counted unknown'))).toHaveLength(2);
    expect(crash.warnings.join('\n')).toContain('Maximum call stack size exceeded');
    expect(JSON.stringify(c)).not.toContain('Maximum call stack');
  });

  it('validates', () => {
    expect(validateCatalog(c)).toMatchObject({ ok: true });
  });

  // A file the user cannot read; root reads everything, and Windows ignores the mode bits.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'counts an unreadable file as crashed',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'dashlint-catalog-'));
      temps.push(root);
      cpSync(join(FIXTURES, 'posthog-js/stub'), root, { recursive: true });
      chmodSync(join(root, 'src/reader.ts'), 0o000);
      const r = extractCatalog({ ...input('posthog-js/stub'), repoRoot: root });
      chmodSync(join(root, 'src/reader.ts'), 0o644);
      if (!r.ok) throw new Error(r.error);
      expect(r.value.catalog.coverage.crashedFiles).toBe(1);
      expect(r.value.catalog.openWorld).toContainEqual({
        file: 'src/reader.ts',
        line: 1,
        kind: 'file-error',
        reason: 'the file could not be read; its calls are unknown',
      });
    },
  );

  /** A program whose type checker throws, like an internal TypeScript assertion, when `fails`. */
  function faulty(
    fails: (node: ts.Node) => boolean,
    onChecker = false,
  ): typeof createSourceProgram {
    return (programInput) => {
      const r = createSourceProgram(programInput);
      if (!r.ok) return r;
      const checker = r.value.program.getTypeChecker();
      const resolve = checker.getResolvedSignature.bind(checker);
      checker.getResolvedSignature = (node, ...rest) => {
        if (fails(node)) throw new Error('Debug Failure. False expression.');
        return resolve(node, ...rest);
      };
      if (onChecker)
        r.value.program.getTypeChecker = () => {
          throw new Error('Debug Failure. Binder.');
        };
      return r;
    };
  }

  it('blames a checker exception on the file being analysed, leaves it out and goes on', () => {
    const inShelf = (node: ts.Node) => node.getSourceFile().fileName.endsWith('/src/shelf.ts');
    const r = extractCatalog(input('posthog-js/stub'), faulty(inShelf));
    if (!r.ok) throw new Error(r.error);
    const { catalog, warnings } = r.value;
    expect(catalog.openWorld).toContainEqual({
      file: 'src/shelf.ts',
      line: 4,
      kind: 'file-error',
      reason: 'the analysis failed on this file (Error); its calls are unknown',
    });
    expect(catalog.coverage.crashedFiles).toBe(1);
    expect(catalog.events.wishlist_shared).toBeUndefined();
    expect(Object.keys(catalog.events).length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toContain(
      'src/shelf.ts: the analysis failed (Error: Debug Failure',
    );
    expect(JSON.stringify(catalog)).not.toContain('Debug Failure');
  });

  it('fails the source for errors outside per-file analysis', () => {
    expect(
      extractCatalog(input('posthog-js/stub', { source: { name: 'app', path: 'missing' } })),
    ).toMatchObject({ ok: false });
    const r = extractCatalog(
      input('posthog-js/stub'),
      faulty(() => false, true),
    );
    expect(r).toEqual({
      ok: false,
      error:
        'source "app": the analysis failed outside any one file: Error: Debug Failure. Binder.',
    });
  });

  it('measures nesting without recursion', () => {
    const deep = ts.createSourceFile(
      'a.ts',
      `const a = ${'['.repeat(400)}${']'.repeat(400)};`,
      ts.ScriptTarget.ES2022,
    );
    expect(nestsDeeper(deep, 300)).toBe(true);
    expect(nestsDeeper(deep, 500)).toBe(false);
  });
});

describe('extractCatalog: catalog fields', () => {
  it('writes source, sdks, the commit and the platforms', () => {
    const { catalog } = extract('posthog-js/stub', { commit: '5f0c2e1' });
    expect(catalog.source).toEqual({
      name: 'app',
      root: '.',
      commit: '5f0c2e1',
      platforms: ['web'],
      sdks: [{ id: 'posthog-js', version: null, types: 'stub' }],
    });
    expect(catalog.schema).toBe('dashlint.catalog/1');
    expect(catalog.tool).toBe('0.0.0-test');
  });

  it('reads the commit with git when none is given', () => {
    const { catalog } = extract('posthog-js/stub', { commit: undefined });
    // The fixture sits inside the dashlint repository, so its HEAD is a full hash.
    expect(catalog.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('narrows each site to its React Native platform suffix', () => {
    const { catalog } = extract('posthog-react-native/platforms');
    const platforms = Object.values(catalog.events).flatMap((e) =>
      e.sites.map((s) => `${s.file} ${s.platforms.join(',')}`),
    );
    expect(platforms.some((p) => p.includes('.ios.') && p.endsWith(' ios'))).toBe(true);
    expect(platforms.some((p) => p.includes('.android.') && p.endsWith(' android'))).toBe(true);
  });

  it('carries open super property calls and builtins turned off', () => {
    const sp = createSourceProgram({
      ...input('posthog-js/super'),
      source: { name: 'app', path: '.' },
    });
    if (!sp.ok) throw new Error(sp.error);
    const supers = resolveSuperProperties(sp.value, findSdkCalls(sp.value, descriptors).calls);
    const { catalog } = extract('posthog-js/super');
    expect(supers.openSuperSites).toBeGreaterThan(0);
    expect(catalog.coverage.openSuperSites).toBe(supers.openSuperSites);
    expect(catalog.coverage.openPersonSites).toBe(supers.openPersonSites);
    expect(catalog.superProperties).toEqual(supers.superProperties);

    const off = extract('posthog-react-native/lifecycle-off').catalog;
    const offProgram = createSourceProgram(input('posthog-react-native/lifecycle-off'));
    if (!offProgram.ok) throw new Error(offProgram.error);
    const scan = resolveBuiltins(offProgram.value);
    expect(scan.off.length).toBeGreaterThan(0);
    expect(off.builtins).toEqual({ ...scan.builtins, off: scan.off });
  });

  it('merges the sites of one event: always only when every site sends the property always', () => {
    const { catalog } = extract('posthog-js/properties');
    for (const event of Object.values(catalog.events)) {
      expect(event.openSites).toBe(event.sites.filter((s) => s.openProperties).length);
    }
  });
});

describe('extractCatalog: every fixture', () => {
  const results = new Map(REPOS.map((repo) => [repo, extractCatalog(input(repo))] as const));

  it.each(REPOS)('%s extracts and validates against the schema', (repo) => {
    const r = results.get(repo);
    if (!r?.ok) throw new Error(r?.error);
    const v = validateCatalog(JSON.parse(writeCatalog(r.value.catalog)));
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it.each(REPOS)('%s is byte-identical on a second run', (repo) => {
    const first = results.get(repo);
    const second = extractCatalog(input(repo));
    if (!first?.ok || !second.ok) throw new Error('extract failed');
    expect(writeCatalog(second.value.catalog)).toBe(writeCatalog(first.value.catalog));
  });

  it.each(REPOS)('%s holds no source text', (repo) => {
    const r = results.get(repo);
    if (!r?.ok) throw new Error(r?.error);
    expect(sourceTextIn(r.value.catalog, codeFiles(join(FIXTURES, repo)))).toEqual([]);
  });

  it('the source text search finds a line planted in a copy of a catalog', () => {
    const r = results.get('posthog-js/crash');
    if (!r?.ok) throw new Error(r?.error);
    const planted = structuredClone(r.value.catalog);
    const first = planted.openWorld[0];
    if (!first) throw new Error('no open world entry');
    first.reason = `${first.reason}: posthog.capture('wishlist_shared', { genre_id: genreId, channel: 'link' })`;
    const files = codeFiles(join(FIXTURES, 'posthog-js/crash'));
    expect(sourceTextIn(planted, files)).toEqual([
      "posthog.capture('wishlist_shared', { genre_id: genreId, channel: 'link' })",
    ]);
  });

  it('uses repository-relative paths with / separators', () => {
    for (const [repo, r] of results) {
      if (!r.ok) continue;
      const root = join(FIXTURES, repo);
      const json = writeCatalog(r.value.catalog);
      expect(json, repo).not.toContain(root);
      expect(json, repo).not.toContain('\\\\');
      expect(relative(root, root)).toBe('');
    }
  });
});

describe('writeCatalog', () => {
  const { catalog } = extract('posthog-js/crash');

  it('writes the fields in the order of spec 6.3.1 and parses back to the same catalog', () => {
    const json = writeCatalog(catalog);
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      'schema',
      'tool',
      'source',
      'coverage',
      'openWorld',
      'events',
      'superProperties',
      'personProperties',
      'builtins',
      'identity',
    ]);
    expect(JSON.parse(json)).toEqual(catalog);
    expect(json.endsWith('}\n')).toBe(true);
  });

  it('sorts names by code point, integer-like names included', () => {
    const base = catalog.events.wishlist_shared;
    if (!base) throw new Error('no event');
    const c: Catalog = { ...catalog, events: { b: base, '404': base, A: base, a: base } };
    const json = writeCatalog(c);
    const order = ['"404"', '"A"', '"a"', '"b"'].map((k) => json.indexOf(`${k}: {`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
  });

  it('writes values in their own key order and keeps JSON types', () => {
    const json = writeCatalog(catalog);
    expect(json).toContain('"values": {\n');
    expect(json).toMatch(/"kind": "finite",\n\s+"set": \[\n\s+"link"\n/);
  });
});
