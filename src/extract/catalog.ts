// The `extract` library entry point and the catalog writer (spec 6.3.1, 6.4 items 10 and 12, T3.8):
// one source's stages run in order and become a `dashlint.catalog/1`, written with a fixed key order
// so two runs on the same input are byte-identical. Crash guard (ADR-028): a file whose parse
// throws or that nests deeper than MAX_NESTING is left out by the program (program.ts); TypeScript
// throwing while the stages analyse a file (an internal assertion) is blamed on the last node of an
// analysed file the checker was given, and the run starts again without that file. Either way the
// file is unknown, counted and listed as `file-error`. Only an error that no analysed file can be
// blamed for fails the source (exit 3). No source text is ever stored.
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import type { Descriptor } from '../descriptors/index.js';
import { orderedJson } from '../formats/canonical.js';
import {
  CATALOG_SCHEMA,
  type CallSite,
  type Catalog,
  type CatalogEvent,
  type EventSite,
  type OpenWorldSite,
  type PropertyFact,
  type ValueDomain,
} from '../formats/catalog.js';
import { validateCatalog } from '../formats/validate.js';
import { resolveBuiltins } from './builtins.js';
import { findIdentityCalls } from './identity.js';
import { nameResolutionRate, resolveEventNames } from './names.js';
import { sitePlatforms } from './platforms.js';
import {
  createSourceProgram,
  MAX_NESTING,
  type ProgramInput,
  type SourceProgram,
} from './program.js';
import { mergeSiteProperties, resolveProperties, type PropertySite } from './properties.js';
import { lineOf } from './sdk-calls.js';
import { resolveSuperProperties } from './super.js';
import { followWrappers } from './wrappers.js';

export interface ExtractInput extends Omit<ProgramInput, 'leaveOut'> {
  /** The dashlint version that writes the catalog. */
  tool: string;
  /** The source's platforms from config (`platform`), at least one. */
  platforms: string[];
  /** The repository's commit; read with `git rev-parse HEAD` when left out (null outside git). */
  commit?: string | null;
}

export interface Extracted {
  catalog: Catalog;
  /** Problems worth printing (tsconfig, crashed files with their errors); never in the catalog. */
  warnings: string[];
}

export type ExtractResult = { ok: true; value: Extracted } | { ok: false; error: string };

/** A file the catalog lists as unknown (`file-error`). */
interface Crash {
  file: string;
  line: number;
  reason: string;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSites(
  a: Pick<OpenWorldSite, 'file' | 'line'>,
  b: Pick<OpenWorldSite, 'file' | 'line'>,
): number {
  return byCodePoint(a.file, b.file) || a.line - b.line;
}

/** The class of a thrown value (`RangeError`), never its message: a message may quote source. */
function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isNode(value: unknown): value is ts.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'number' &&
    typeof (value as { getSourceFile?: unknown }).getSourceFile === 'function'
  );
}

/**
 * Remembers the last node of an analysed file that was handed to the type checker, so an
 * exception can be blamed on the file being analysed when it was thrown.
 */
class Blame {
  last: ts.Node | undefined;

  constructor(private readonly analysed: ReadonlySet<ts.SourceFile>) {}

  note(args: readonly unknown[]): void {
    for (const arg of args) {
      if (!isNode(arg)) continue;
      const sf = arg.getSourceFile() as ts.SourceFile | undefined;
      if (sf && this.analysed.has(sf)) {
        this.last = arg;
        return;
      }
    }
  }
}

/** The source program with a type checker that tells `blame` which node it is working on. */
function watched(sp: SourceProgram, blame: Blame): SourceProgram {
  const checker = sp.program.getTypeChecker();
  const watchedChecker: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(checker)) {
    watchedChecker[key] =
      typeof value === 'function'
        ? (...args: unknown[]) => {
            blame.note(args);
            return (value as (...a: unknown[]) => unknown).apply(checker, args);
          }
        : value;
  }
  const program = new Proxy(sp.program, {
    get: (target, key, receiver) =>
      key === 'getTypeChecker' ? () => watchedChecker : Reflect.get(target, key, receiver),
  });
  return { ...sp, program };
}

interface Stages {
  properties: ReturnType<typeof resolveProperties>;
  names: ReturnType<typeof resolveEventNames>;
  supers: ReturnType<typeof resolveSuperProperties>;
  identity: ReturnType<typeof findIdentityCalls>;
  builtins: ReturnType<typeof resolveBuiltins>;
}

function runStages(sp: SourceProgram, descriptors: readonly Descriptor[]): Stages {
  const wrappers = followWrappers(sp, descriptors);
  const names = resolveEventNames(sp, wrappers);
  const properties = resolveProperties(sp, names);
  const supers = resolveSuperProperties(sp, wrappers.sdkCalls.calls);
  const identity = findIdentityCalls(wrappers.sdkCalls.calls);
  const builtins = resolveBuiltins(sp);
  return { properties, names, supers, identity, builtins };
}

function gitCommit(repoRoot: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const sha = r.status === 0 ? r.stdout.trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

function catalogEvents(
  sites: readonly PropertySite[],
  platforms: readonly string[],
): Record<string, CatalogEvent> {
  const byName = new Map<string, { site: EventSite; property: PropertySite }[]>();
  for (const property of sites) {
    const { event } = property.site;
    const site: EventSite = {
      file: event.file,
      line: event.line,
      sdk: event.descriptor.sdk,
      via: [...event.via],
      platforms: sitePlatforms(event.file, platforms),
      openProperties: property.openProperties,
    };
    for (const name of property.site.names) {
      const list = byName.get(name) ?? [];
      list.push({ site, property });
      byName.set(name, list);
    }
  }
  const events: Record<string, CatalogEvent> = {};
  for (const name of [...byName.keys()].sort(byCodePoint)) {
    // Stable: sites on one line keep the order the stages found them in.
    const list = (byName.get(name) ?? []).sort((a, b) => compareSites(a.site, b.site));
    const merged = mergeSiteProperties(list.map((l) => l.property));
    events[name] = { sites: list.map((l) => l.site), ...merged };
  }
  return events;
}

function buildCatalog(
  input: ExtractInput,
  sp: SourceProgram,
  stages: Stages,
  crashes: readonly Crash[],
): Catalog {
  const crashed = crashes.length;
  const { coverage: found } = stages.names;
  const callSites = found.callSites + crashed;
  const openWorld: OpenWorldSite[] = [
    ...stages.properties.openWorld,
    ...stages.supers.openWorld,
    ...crashes.map((c) => ({
      file: c.file,
      line: c.line,
      kind: 'file-error' as const,
      reason: c.reason,
    })),
  ].sort(
    (a, b) => compareSites(a, b) || byCodePoint(a.kind, b.kind) || byCodePoint(a.reason, b.reason),
  );
  const identity = [...stages.identity].sort(
    (a, b) => compareSites(a, b) || byCodePoint(a.call, b.call),
  );
  return {
    schema: CATALOG_SCHEMA,
    tool: input.tool,
    source: {
      name: input.source.name,
      root: sp.root,
      commit: input.commit === undefined ? gitCommit(sp.repoRoot) : input.commit,
      platforms: [...input.platforms],
      sdks: sp.sdks.map((s) => ({ ...s.sdk })),
    },
    coverage: {
      files: sp.coverage.files,
      excludedFiles: sp.coverage.excludedFiles,
      oversizeFiles: sp.coverage.oversizeFiles ?? 0,
      crashedFiles: crashed,
      callSites,
      literalNameSites: found.literalNameSites,
      // A crashed file may hold any number of calls: one open site each, so no event is "no".
      openSites: found.openSites + crashed,
      nameResolutionRate: nameResolutionRate(found.literalNameSites, callSites),
      openSuperSites: stages.supers.openSuperSites,
      openPersonSites: stages.supers.openPersonSites,
    },
    openWorld,
    events: catalogEvents(stages.properties.sites, input.platforms),
    superProperties: stages.supers.superProperties,
    personProperties: stages.supers.personProperties,
    builtins: { ...stages.builtins.builtins, off: stages.builtins.off },
    identity,
  };
}

/**
 * Extracts one source's catalog. A file TypeScript throws on while parsing or analysing it, one
 * that nests too deep and one that cannot be read are counted in `coverage.crashedFiles`, listed in
 * `openWorld` as `file-error` and left out; the error is returned in `warnings`. Fails only for
 * errors outside per-file analysis (exit 3). `create` builds the program (a test seam).
 */
export function extractCatalog(
  input: ExtractInput,
  create: typeof createSourceProgram = createSourceProgram,
): ExtractResult {
  const analysisCrashes: Crash[] = [];
  const warnings: string[] = [];
  for (;;) {
    const r = create({ ...input, leaveOut: analysisCrashes.map((c) => c.file) });
    if (!r.ok) return r;
    const sp = r.value;
    const analysed = new Set(
      sp.files.flatMap((f) => {
        const sf = sp.program.getSourceFile(f);
        return sf ? [sf] : [];
      }),
    );
    const blame = new Blame(analysed);
    let stages: Stages;
    try {
      stages = runStages(watched(sp, blame), input.descriptors);
    } catch (error) {
      const node = blame.last;
      const file =
        node && sp.files.find((f) => sp.program.getSourceFile(f) === node.getSourceFile());
      const rel = file === undefined ? undefined : relativeTo(sp.repoRoot, file);
      // A file blamed twice was not left out: blaming it again would never end.
      if (!node || rel === undefined || analysisCrashes.some((c) => c.file === rel))
        return {
          ok: false,
          error: `source "${input.source.name}": the analysis failed outside any one file: ${errorText(error)}`,
        };
      analysisCrashes.push({
        file: rel,
        line: lineOf(node),
        reason: `the analysis failed on this file (${errorName(error)}); its calls are unknown`,
      });
      warnings.push(
        `${rel}: the analysis failed (${errorText(error)}); the file is counted unknown`,
      );
      continue;
    }
    const crashes: Crash[] = [
      ...analysisCrashes,
      ...sp.crashed.map((p) => ({
        file: p.file,
        line: 1,
        reason:
          p.why === 'parse'
            ? `TypeScript could not parse this file (${errorName(p.error)}); its calls are unknown`
            : `the file nests deeper than ${MAX_NESTING} levels; its calls are unknown`,
      })),
      ...sp.unreadable.map((file) => ({
        file,
        line: 1,
        reason: 'the file could not be read; its calls are unknown',
      })),
    ];
    for (const p of sp.crashed)
      warnings.push(
        p.why === 'parse'
          ? `${p.file}: TypeScript could not parse it (${errorText(p.error)}); the file is counted unknown`
          : `${p.file}: nests deeper than ${MAX_NESTING} levels; the file is counted unknown`,
      );
    for (const file of sp.unreadable)
      warnings.push(`${file}: could not be read; the file is counted unknown`);
    const catalog = buildCatalog(input, sp, stages, crashes);
    const valid = validateCatalog(catalog);
    if (!valid.ok)
      return {
        ok: false,
        error: `source "${input.source.name}": the catalog does not validate: ${valid.errors
          .map((e) => `${e.path} ${e.message}`)
          .join('; ')}`,
      };
    return { ok: true, value: { catalog, warnings: [...sp.warnings, ...warnings] } };
  }
}

function relativeTo(repoRoot: string, file: string): string {
  return file.startsWith(`${repoRoot}/`) ? file.slice(repoRoot.length + 1) : file;
}

// The writer: every object becomes a Map in the order spec 6.3.1 shows; names sort by code point.

function fields(o: object, keys: readonly string[]): Map<string, unknown> {
  const record = o as Record<string, unknown>;
  return new Map(keys.filter((k) => record[k] !== undefined).map((k) => [k, record[k]]));
}

function names<T>(o: Record<string, T>, each: (value: T) => unknown): Map<string, unknown> {
  return new Map(
    Object.keys(o)
      .sort(byCodePoint)
      .map((k) => [k, each(o[k] as T)]),
  );
}

function domain(v: ValueDomain): Map<string, unknown> {
  return v.kind === 'finite' ? fields(v, ['kind', 'set']) : fields(v, ['kind', 'type']);
}

function fact(p: PropertyFact): Map<string, unknown> {
  return new Map<string, unknown>([
    ['presence', p.presence],
    ['values', domain(p.values)],
  ]);
}

function callSites(sites: readonly CallSite[]): Map<string, unknown>[] {
  return sites.map((s) => fields(s, ['file', 'line', 'call']));
}

/** The catalog as JSON: fixed key order, two-space indent, one trailing newline. */
export function writeCatalog(c: Catalog): string {
  return orderedJson(
    new Map<string, unknown>([
      ['schema', c.schema],
      ['tool', c.tool],
      [
        'source',
        new Map<string, unknown>([
          ...fields(c.source, ['name', 'root', 'commit', 'platforms']),
          ['sdks', c.source.sdks.map((s) => fields(s, ['id', 'version', 'types']))],
        ]),
      ],
      [
        'coverage',
        fields(c.coverage, [
          'files',
          'excludedFiles',
          'oversizeFiles',
          'crashedFiles',
          'callSites',
          'literalNameSites',
          'openSites',
          'nameResolutionRate',
          'openSuperSites',
          'openPersonSites',
        ]),
      ],
      ['openWorld', c.openWorld.map((o) => fields(o, ['file', 'line', 'kind', 'reason']))],
      [
        'events',
        names(
          c.events,
          (e) =>
            new Map<string, unknown>([
              [
                'sites',
                e.sites.map((s) =>
                  fields(s, ['file', 'line', 'sdk', 'via', 'platforms', 'openProperties']),
                ),
              ],
              ['openSites', e.openSites],
              ['properties', names(e.properties, fact)],
            ]),
        ),
      ],
      [
        'superProperties',
        names(
          c.superProperties,
          (p) => new Map<string, unknown>([...fact(p), ['sites', callSites(p.sites)]]),
        ),
      ],
      [
        'personProperties',
        names(c.personProperties, (p) => new Map<string, unknown>([['sites', callSites(p.sites)]])),
      ],
      ['builtins', fields(c.builtins, ['events', 'properties', 'conditional', 'off'])],
      ['identity', c.identity.map((i) => fields(i, ['call', 'file', 'line', 'context']))],
    ]),
  );
}
