// CI mode (spec 6.7.5, D5): the base and head catalogs checked against the head's requirements.
// Only tiles the change newly breaks at or above `failOn` fail; tiles already broken on the base are
// a count; verdict changes a requirements edit causes are information. `check` imports `formats`
// only, so the caller passes the extraction (catalogs, context, enclosing functions). Choices the
// spec leaves open are in ADR-042.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orderedJson } from '../formats/canonical.js';
import type { Catalog, JsonScalar, PropertyFact, ValueDomain } from '../formats/catalog.js';
import type { AlertResult, Location, Verdict } from '../formats/report.js';
import type { Requirements } from '../formats/requirements.js';
import { loadRequirements } from '../formats/yaml.js';
import { checkAlerts } from './alerts.js';
import type { CheckContext } from './checks/types.js';
import { applyIgnore } from './ignore.js';
import type { IgnoreEntry, IgnoreOutcome, IgnoreWarning } from './ignore.js';
import { checkTiles } from './verdicts.js';

export const FAIL_ON = ['dead', 'partly-dead', 'degraded', 'never'] as const;
export type FailOn = (typeof FAIL_ON)[number];

/** How broken a decided verdict is; not checked and ignored have no rank. */
const RANK: Partial<Record<Verdict, number>> = {
  live: 0,
  'one-platform': 1,
  degraded: 2,
  'partly-dead': 3,
  dead: 4,
};
const FAIL_RANK: Record<FailOn, number> = {
  degraded: 2,
  'partly-dead': 3,
  dead: 4,
  never: Number.POSITIVE_INFINITY,
};

/** True when a verdict is at or above the `failOn` level (never for not checked or ignored). */
export function atOrAbove(verdict: Verdict, failOn: FailOn): boolean {
  const r = RANK[verdict];
  return r !== undefined && r >= FAIL_RANK[failOn];
}

// ---- Catalog changes ----------------------------------------------------------------------------

export interface SourceSite extends Location {
  source: string;
}

export type CatalogChange =
  | { kind: 'event-removed'; event: string; sites: SourceSite[] }
  | { kind: 'event-added'; event: string; sites: SourceSite[] }
  /** A removed and an added event with sites in the same enclosing function. */
  | { kind: 'event-renamed'; from: string; to: string; function: string; sites: SourceSite[] }
  /** `event` null: a super property. */
  | { kind: 'property-removed'; event: string | null; property: string }
  | { kind: 'values-narrowed'; event: string | null; property: string; removed: JsonScalar[] };

/** `(file, line) => enclosing function` on one side; null when the site is not in a function. */
export type Enclosing = (file: string, line: number) => string | null;

interface SideEvent {
  sites: SourceSite[];
  open: boolean;
  properties: Map<string, ValueDomain>;
}

interface SideView {
  events: Map<string, SideEvent>;
  supers: Map<string, ValueDomain>;
  openSupers: boolean;
}

function mergeDomain(a: ValueDomain | undefined, b: ValueDomain): ValueDomain {
  if (a === undefined) return b;
  if (a.kind === 'open') return a;
  if (b.kind === 'open') return b;
  const seen = new Map(a.set.map((v) => [JSON.stringify(v), v]));
  for (const v of b.set) seen.set(JSON.stringify(v), v);
  return { kind: 'finite', set: [...seen.values()] };
}

function addProps(into: Map<string, ValueDomain>, props: Record<string, PropertyFact>): void {
  for (const [k, p] of Object.entries(props)) into.set(k, mergeDomain(into.get(k), p.values));
}

function view(catalogs: readonly Catalog[]): SideView {
  const events = new Map<string, SideEvent>();
  const supers = new Map<string, ValueDomain>();
  let openSupers = false;
  for (const c of catalogs) {
    for (const [name, e] of Object.entries(c.events)) {
      const v: SideEvent = events.get(name) ?? { sites: [], open: false, properties: new Map() };
      v.sites.push(...e.sites.map((s) => ({ source: c.source.name, file: s.file, line: s.line })));
      v.open ||= e.openSites > 0;
      addProps(v.properties, e.properties);
      events.set(name, v);
    }
    addProps(supers, c.superProperties);
    // A crashed file may hold any call: every event and super property is open.
    openSupers ||= (c.coverage.openSuperSites ?? 0) > 0 || (c.coverage.crashedFiles ?? 0) > 0;
  }
  return { events, supers, openSupers };
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function propertyChanges(
  event: string | null,
  base: ReadonlyMap<string, ValueDomain>,
  head: ReadonlyMap<string, ValueDomain>,
  headOpen: boolean,
  /** Keys the head still sends another way (its super properties). */
  stillSent: ReadonlyMap<string, unknown> = new Map(),
): CatalogChange[] {
  const out: CatalogChange[] = [];
  for (const property of [...base.keys()].sort(byText)) {
    const b = base.get(property) as ValueDomain;
    const h = head.get(property);
    // An open head may still send the key: no "removed" claim from it.
    if (h === undefined) {
      if (!headOpen && !stillSent.has(property))
        out.push({ kind: 'property-removed', event, property });
      continue;
    }
    if (b.kind !== 'finite' || h.kind !== 'finite') continue;
    const kept = new Set(h.set.map((v) => JSON.stringify(v)));
    const removed = b.set.filter((v) => !kept.has(JSON.stringify(v)));
    if (removed.length > 0) out.push({ kind: 'values-narrowed', event, property, removed });
  }
  return out;
}

/** Which removed event was renamed to which added one: pairs that match one to one only. */
function renames(
  removed: readonly string[],
  added: readonly string[],
  base: SideView,
  head: SideView,
  enclosing: { base?: Enclosing | undefined; head?: Enclosing | undefined },
): { from: string; to: string; function: string }[] {
  const eb = enclosing.base;
  const eh = enclosing.head;
  if (eb === undefined || eh === undefined) return [];
  const keys = (sites: readonly SourceSite[], at: Enclosing) => {
    const out = new Set<string>();
    for (const s of sites) {
      const f = at(s.file, s.line);
      if (f !== null) out.add(JSON.stringify([s.source, s.file, f]));
    }
    return out;
  };
  const headKeys = new Map(
    added.map((a) => [a, keys((head.events.get(a) as SideEvent).sites, eh)]),
  );
  const candidates = new Map<string, { to: string; key: string }[]>();
  for (const r of removed) {
    const rk = keys((base.events.get(r) as SideEvent).sites, eb);
    const found: { to: string; key: string }[] = [];
    for (const a of added) {
      const shared = [...rk].filter((k) => (headKeys.get(a) as Set<string>).has(k)).sort(byText);
      if (shared.length > 0) found.push({ to: a, key: shared[0] as string });
    }
    candidates.set(r, found);
  }
  const out: { from: string; to: string; function: string }[] = [];
  for (const r of removed) {
    const found = candidates.get(r) as { to: string; key: string }[];
    if (found.length !== 1) continue;
    const { to, key } = found[0] as { to: string; key: string };
    const rivals = removed.filter((o) => (candidates.get(o) ?? []).some((c) => c.to === to));
    if (rivals.length !== 1) continue;
    const [, , fn] = JSON.parse(key) as [string, string, string];
    out.push({ from: r, to, function: fn });
  }
  return out;
}

/**
 * The change list between two sets of catalogs: events removed, added or renamed; event and super
 * properties removed; finite value sets narrowed. Renames need both `enclosing` functions.
 */
export function diffCatalogs(
  base: readonly Catalog[],
  head: readonly Catalog[],
  enclosing: { base?: Enclosing | undefined; head?: Enclosing | undefined } = {},
): CatalogChange[] {
  const b = view(base);
  const h = view(head);
  const removed = [...b.events.keys()].filter((e) => !h.events.has(e)).sort(byText);
  const added = [...h.events.keys()].filter((e) => !b.events.has(e)).sort(byText);
  const renamed = renames(removed, added, b, h, enclosing);
  const from = new Set(renamed.map((r) => r.from));
  const to = new Set(renamed.map((r) => r.to));

  const out: CatalogChange[] = [];
  for (const event of removed)
    if (!from.has(event))
      out.push({ kind: 'event-removed', event, sites: (b.events.get(event) as SideEvent).sites });
  for (const event of added)
    if (!to.has(event))
      out.push({ kind: 'event-added', event, sites: (h.events.get(event) as SideEvent).sites });
  for (const r of renamed)
    out.push({
      kind: 'event-renamed',
      ...r,
      sites: (h.events.get(r.to) as SideEvent).sites,
    });
  const pairs: [string, string][] = [
    ...[...b.events.keys()].filter((e) => h.events.has(e)).map((e): [string, string] => [e, e]),
    ...renamed.map((r): [string, string] => [r.from, r.to]),
  ].sort((x, y) => byText(x[1], y[1]));
  for (const [bn, hn] of pairs) {
    const be = b.events.get(bn) as SideEvent;
    const he = h.events.get(hn) as SideEvent;
    out.push(
      ...propertyChanges(hn, be.properties, he.properties, he.open || h.openSupers, h.supers),
    );
  }
  out.push(...propertyChanges(null, b.supers, h.supers, h.openSupers));
  return out;
}

// ---- Verdict changes ----------------------------------------------------------------------------

export interface TileChange {
  id: string;
  title: string;
  base: Verdict;
  head: Verdict;
  /** Newly broken at or above `failOn`: the change fails the run. */
  fails: boolean;
}

export interface AlertChange {
  id: string;
  name?: string;
  tile: string;
  base: AlertResult;
  head: AlertResult;
}

/** A tile whose verdict on the base code moved because the requirements changed: information. */
export interface RequirementsTileChange {
  id: string;
  title: string;
  change: 'added' | 'removed' | 'changed';
  /** The verdict on the base code with the base's requirements. */
  before?: Verdict;
  /** The verdict on the base code with the head's requirements. */
  after?: Verdict;
}

export interface DiffSide {
  catalogs: readonly Catalog[];
  commit: string | null;
  enclosing?: Enclosing;
}

export interface DiffInput {
  /** The head's requirements: both sides are checked against them. */
  requirements: Requirements;
  /**
   * The base's requirements: null when the base has no requirements file; absent when unknown (a
   * base catalog file, or a base copy that does not load).
   */
  baseRequirements?: Requirements | null;
  base: DiffSide;
  head: DiffSide;
  /** Builds the check context (code facts from the merged catalogs, observed data, profile). */
  contextFor: (catalogs: readonly Catalog[], requirements: Requirements) => CheckContext;
  failOn: FailOn;
  ignore?: readonly IgnoreEntry[];
  now: Date;
}

export interface DiffResult {
  failOn: FailOn;
  base: { commit: string | null };
  head: { commit: string | null };
  /** Tiles whose verdict got worse, those that fail first, then by id. */
  worse: TileChange[];
  fixed: TileChange[];
  /** Other verdict changes, to or from "not checked". */
  changed: TileChange[];
  /** Tiles at or above `failOn` on both sides: a count, never a failure (D5). */
  alreadyBroken: number;
  ignored: number;
  alerts: { worse: AlertChange[]; fixed: AlertChange[] };
  /** Information only, never a failure; `new`: the base had no requirements file. */
  requirements: {
    status: 'unchanged' | 'changed' | 'new' | 'unknown';
    tiles: RequirementsTileChange[];
  };
  catalog: CatalogChange[];
  warnings: IgnoreWarning[];
  /** Exit 1 when true. */
  fails: boolean;
}

const ALERT_BROKEN = new Set<AlertResult>([
  'can-never-fire',
  'fires-every-check',
  'invalid-target',
]);

function evaluate(
  input: DiffInput,
  catalogs: readonly Catalog[],
  requirements: Requirements,
): IgnoreOutcome {
  const ctx = input.contextFor(catalogs, requirements);
  return applyIgnore(
    requirements,
    checkTiles(ctx, requirements),
    checkAlerts(ctx, requirements),
    input.ignore ?? [],
    input.now,
  );
}

function verdicts(o: IgnoreOutcome): Map<string, Verdict> {
  return new Map(o.tiles.map((t) => [t.result.id, t.verdict]));
}

function requirementsChanges(
  input: DiffInput,
  after: ReadonlyMap<string, Verdict>,
): DiffResult['requirements'] {
  const base = input.baseRequirements;
  const head = input.requirements;
  if (base === undefined) return { status: 'unknown', tiles: [] };
  if (base === null) return { status: 'new', tiles: [] };
  if (orderedJson(base) === orderedJson(head)) return { status: 'unchanged', tiles: [] };
  const before = verdicts(evaluate(input, input.base.catalogs, base));
  const baseTiles = new Map(base.tiles.map((t) => [t.id, t]));
  const headIds = new Set(head.tiles.map((t) => t.id));
  const tiles: RequirementsTileChange[] = [];
  for (const t of head.tiles) {
    const a = after.get(t.id) as Verdict;
    if (!baseTiles.has(t.id)) tiles.push({ id: t.id, title: t.title, change: 'added', after: a });
    else {
      const b = before.get(t.id) as Verdict;
      if (b !== a) tiles.push({ id: t.id, title: t.title, change: 'changed', before: b, after: a });
    }
  }
  for (const t of base.tiles)
    if (!headIds.has(t.id))
      tiles.push({
        id: t.id,
        title: t.title,
        change: 'removed',
        before: before.get(t.id) as Verdict,
      });
  tiles.sort((x, y) => byText(x.id, y.id));
  return { status: 'changed', tiles };
}

/** Compares the two sides (spec 6.7.5) without touching git: the base may come from a catalog file. */
export function diffResults(input: DiffInput): DiffResult {
  const { requirements, failOn } = input;
  const base = evaluate(input, input.base.catalogs, requirements);
  const head = evaluate(input, input.head.catalogs, requirements);
  const before = verdicts(base);
  const after = verdicts(head);
  const fail = FAIL_RANK[failOn];

  const worse: TileChange[] = [];
  const fixed: TileChange[] = [];
  const changed: TileChange[] = [];
  let alreadyBroken = 0;
  let ignored = 0;
  for (const t of requirements.tiles) {
    const b = before.get(t.id) as Verdict;
    const h = after.get(t.id) as Verdict;
    if (h === 'ignored') {
      ignored++;
      continue;
    }
    if (atOrAbove(b, failOn) && atOrAbove(h, failOn)) alreadyBroken++;
    if (b === h) continue;
    const rb = RANK[b];
    const rh = RANK[h];
    const change = (fails: boolean): TileChange => ({
      id: t.id,
      title: t.title,
      base: b,
      head: h,
      fails,
    });
    if (rb !== undefined && rh !== undefined) {
      if (rh > rb) worse.push(change(rb < fail && rh >= fail));
      else fixed.push(change(false));
    } else if (b === 'not-checked' && rh !== undefined && rh >= (RANK.degraded as number))
      // Undecided on the base: it may have been broken already, so it never fails (ADR-042).
      worse.push(change(false));
    else changed.push(change(false));
  }
  worse.sort((x, y) => Number(y.fails) - Number(x.fails) || byText(x.id, y.id));
  fixed.sort((x, y) => byText(x.id, y.id));
  changed.sort((x, y) => byText(x.id, y.id));

  const baseAlerts = new Map(base.alerts.map((a) => [a.result.id, a.result.result]));
  const alerts: DiffResult['alerts'] = { worse: [], fixed: [] };
  for (const a of head.alerts) {
    if (a.ignored !== undefined) continue;
    const b = baseAlerts.get(a.result.id) as AlertResult;
    const h = a.result.result;
    const c: AlertChange = {
      id: a.result.id,
      ...(a.result.name === undefined ? {} : { name: a.result.name }),
      tile: a.result.tile,
      base: b,
      head: h,
    };
    if (!ALERT_BROKEN.has(b) && ALERT_BROKEN.has(h)) alerts.worse.push(c);
    else if (ALERT_BROKEN.has(b) && h === 'ok') alerts.fixed.push(c);
  }

  return {
    failOn,
    base: { commit: input.base.commit },
    head: { commit: input.head.commit },
    worse,
    fixed,
    changed,
    alreadyBroken,
    ignored,
    alerts,
    requirements: requirementsChanges(input, before),
    catalog: diffCatalogs(input.base.catalogs, input.head.catalogs, {
      base: input.base.enclosing,
      head: input.head.enclosing,
    }),
    warnings: head.warnings,
    fails: worse.some((c) => c.fails),
  };
}

// ---- Git ----------------------------------------------------------------------------------------

/** A git command failed or a ref does not name a commit: a usage error (exit 2). */
export class DiffGitError extends Error {
  override name = 'DiffGitError';
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The commit a ref names, or a `DiffGitError` saying the ref is not a commit. */
export function resolveCommit(repo: string, ref: string): string {
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  } catch {
    throw new DiffGitError(`\`${ref}\` is not a commit in ${repo}`);
  }
}

/** A file's text at a commit; undefined when the commit has no such file. */
export function readAtCommit(repo: string, commit: string, path: string): string | undefined {
  const spec = `${commit}:${path.replace(/\\/g, '/')}`;
  try {
    git(repo, ['cat-file', '-e', spec]);
  } catch {
    return undefined;
  }
  return execFileSync('git', ['-C', repo, 'show', spec], { encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Runs `fn` on a temporary `git worktree` of `commit` (detached, no `node_modules`: SDK types come
 * from the stubs, spec 6.4 item 2), then removes the worktree whatever happens.
 */
export function withWorktree<T>(repo: string, commit: string, fn: (root: string) => T): T {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dashlint-base-'));
  const root = join(dir, 'tree');
  try {
    git(repo, ['worktree', 'add', '--detach', '--quiet', root, commit]);
    return fn(root);
  } finally {
    try {
      git(repo, ['worktree', 'remove', '--force', root]);
    } catch {
      // The worktree was never added, or is gone already; prune below forgets it either way.
    }
    rmSync(dir, { recursive: true, force: true });
    try {
      git(repo, ['worktree', 'prune']);
    } catch {
      // Nothing to prune.
    }
  }
}

export interface GitDiffOptions {
  repoRoot: string;
  /** The base ref (`origin/main`, a commit). */
  base: string;
  /** The head ref; absent: the working tree as it is. */
  head?: string;
  /** The head's requirements, already loaded. */
  requirements: Requirements;
  /** The requirements file, relative to the repository root, to read the base's copy. */
  requirementsPath: string;
  /** The catalogs of every configured source under `root` (commit null for the working tree). */
  catalogsAt: (root: string, commit: string | null) => Catalog[];
  /** Enclosing-function lookup for a checkout; without it no event is called renamed. */
  enclosingIn?: (root: string) => Enclosing;
  contextFor: DiffInput['contextFor'];
  failOn: FailOn;
  ignore?: readonly IgnoreEntry[];
  now: Date;
}

/** `dashlint diff --base <ref> [--head <ref>]`: the base (and a head ref) through worktrees. */
export function diffGit(o: GitDiffOptions): DiffResult {
  const baseCommit = resolveCommit(o.repoRoot, o.base);
  const headCommit = o.head === undefined ? null : resolveCommit(o.repoRoot, o.head);
  const baseText = readAtCommit(o.repoRoot, baseCommit, o.requirementsPath);
  const loaded = baseText === undefined ? undefined : loadRequirements(baseText);
  const baseRequirements = loaded === undefined ? null : loaded.ok ? loaded.value : undefined;

  const side = (root: string, commit: string | null): DiffSide => {
    const enclosing = o.enclosingIn?.(root);
    return {
      catalogs: o.catalogsAt(root, commit),
      commit,
      ...(enclosing === undefined ? {} : { enclosing }),
    };
  };
  const run = (headRoot: string) =>
    withWorktree(o.repoRoot, baseCommit, (baseRoot) =>
      diffResults({
        requirements: o.requirements,
        ...(baseRequirements === undefined ? {} : { baseRequirements }),
        base: side(baseRoot, baseCommit),
        head: side(headRoot, headCommit),
        contextFor: o.contextFor,
        failOn: o.failOn,
        ...(o.ignore === undefined ? {} : { ignore: o.ignore }),
        now: o.now,
      }),
    );
  return headCommit === null ? run(o.repoRoot) : withWorktree(o.repoRoot, headCommit, run);
}
