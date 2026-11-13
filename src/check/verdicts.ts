// The verdict algebra (spec 6.7.3): node effects from the checks, then formulas, funnels, retention,
// breakdowns and exclusions, then one tile verdict with its unknown parts and platforms. Ignore
// entries are applied on top of this verdict (T6.6). Choices the spec leaves open are in ADR-040.
import type { TileKind, Verdict } from '../formats/report.js';
import type {
  Filter,
  NotChecked,
  PropertyRef,
  Requirements,
  SeriesNode,
  Tile,
} from '../formats/requirements.js';
import { checkBreakdown } from './checks/breakdown.js';
import { sortedUnique } from './checks/common.js';
import { checkEvent } from './checks/event.js';
import { checkFilter, checkMathProperty, orEffect } from './checks/property.js';
import type { CheckContext, CheckFinding, PartEffect } from './checks/types.js';
import { FORMULA_SERIES_UNKNOWN, formulaRefs, formulaVerdict, parseFormula } from './formula.js';
import type { FormulaEffect } from './formula.js';

/** Paths, SQL and other tiles (spec 6.7.3). */
export const KIND_NOT_CHECKED = 'kind-not-checked';
/** Lifecycle, stickiness or retention tiles after a cut (spec 7.4 items 5 and 6). */
export const KIND_CUT = 'kind-cut';
/** A tile with no series, steps or entities to check. */
export const NO_PARTS = 'no-parts';
export const WAREHOUSE_NODE = 'warehouse-node';
export const AND_GROUP = 'and-group';
export const NO_ACTION_STEPS = 'no-action-steps';
/** An action step with a url, selector, text or other matcher dashlint cannot check. */
export const ACTION_STEP_UNSUPPORTED = 'action-step-unsupported';
/** The tile is on dashboards whose filters differ, so it shows different data on each. */
export const DASHBOARD_FILTERS_DIFFER = 'dashboard-filters-differ';

export type PartVerdict = FormulaEffect;

export type PartRole =
  'series' | 'formula' | 'step' | 'entity' | 'exclusion' | 'breakdown' | 'other';

export interface PartResult {
  path: string;
  role: PartRole;
  effect: PartVerdict;
  /** Unknown only: the reasons, sorted. */
  reasons?: string[];
}

export interface UnknownPart {
  path: string;
  reasons: string[];
}

export type TileVerdict = Exclude<Verdict, 'ignored'>;

export interface TileResult {
  id: string;
  kind: TileKind;
  verdict: TileVerdict;
  /** Platforms feeding the tile's live parts, sorted; shown for every tile. */
  platforms: string[];
  /** The parts the verdict counts: formulas or series, steps or entities, then modifiers. */
  parts: PartResult[];
  /** Every series node by index (also those a formula hides), for the alert checks (T6.5). */
  series: PartResult[];
  findings: CheckFinding[];
  /** Always counted next to the verdict. */
  unknownParts: UnknownPart[];
  /** Not checked as a whole: the reasons, sorted. */
  reasons?: string[];
  /** Partly dead funnels: the first step (1-based) that is always zero. */
  deadFrom?: number;
}

interface AppliedFilter {
  filter: Filter;
  path: string;
}

interface Evaluated {
  effect: PartEffect;
  reasons: string[];
  findings: CheckFinding[];
  /** The events of live or degraded members; null for every event. */
  liveEvents: (string | null)[];
}

interface Member {
  event: string | null;
  path: string;
  filters: AppliedFilter[];
  math?: { ref: PropertyRef; path: string };
  unknown: string[];
}

/** AND of a node's facts: dead wins, then unknown, then degraded (spec 6.7.3 event node). */
export function andEffect(effects: readonly PartEffect[]): PartEffect {
  if (effects.includes('dead')) return 'dead';
  if (effects.includes('unknown')) return 'unknown';
  if (effects.includes('degraded')) return 'degraded';
  return 'live';
}

const producing = (e: PartEffect | PartVerdict): boolean => e === 'live' || e === 'degraded';

function evalMember(ctx: CheckContext, m: Member): Evaluated {
  const effects: PartEffect[] = [];
  const reasons: string[] = [];
  const findings: CheckFinding[] = [];
  if (m.event !== null) {
    const ev = checkEvent(ctx, m.event, m.path);
    if (ev.finding !== undefined) findings.push(ev.finding);
    // A dead event decides the member; its filters would only repeat it.
    if (ev.effect === 'dead') return { effect: 'dead', reasons: [], findings, liveEvents: [] };
    effects.push(ev.effect);
    reasons.push(...(ev.reasons ?? []));
  }
  for (const f of m.filters) {
    const fc = checkFilter(ctx, m.event, f.filter, f.path);
    effects.push(fc.effect);
    reasons.push(...(fc.reasons ?? []));
    for (const c of fc.checks) {
      if (c.finding !== undefined) findings.push(c.finding);
      if (c.value?.finding !== undefined) findings.push(c.value.finding);
    }
  }
  if (m.math !== undefined) {
    const mc = checkMathProperty(ctx, m.event, m.math.ref, m.math.path);
    effects.push(mc.effect);
    reasons.push(...(mc.reasons ?? []));
    if (mc.finding !== undefined) findings.push(mc.finding);
  }
  if (m.unknown.length > 0) {
    effects.push('unknown');
    reasons.push(...m.unknown);
  }
  const effect = andEffect(effects);
  return {
    effect,
    reasons: effect === 'unknown' ? sortedUnique(reasons) : [],
    findings,
    liveEvents: producing(effect) ? [m.event] : [],
  };
}

// A member's finding that disagrees with the group's effect is an info line (spec 6.7.3: a dead
// member inside a live group is PostHog's "historical union").
function orMembers(members: readonly Evaluated[]): Evaluated {
  const effect = orEffect(members.map((m) => m.effect));
  return {
    effect,
    reasons: effect === 'unknown' ? sortedUnique(members.flatMap((m) => m.reasons)) : [],
    findings: members.flatMap((m) =>
      m.findings.map((f) =>
        f.effect !== 'info' && f.effect !== effect ? { ...f, effect: 'info' as const } : f,
      ),
    ),
    liveEvents: members.flatMap((m) => m.liveEvents),
  };
}

function own(filters: readonly Filter[] | undefined, path: string): AppliedFilter[] {
  return (filters ?? []).map((filter, j) => ({ filter, path: `${path}[${j}]` }));
}

function unknownNode(reasons: readonly string[]): Evaluated {
  return { effect: 'unknown', reasons: sortedUnique(reasons), findings: [], liveEvents: [] };
}

function evalNode(
  ctx: CheckContext,
  node: SeriesNode,
  path: string,
  shared: readonly AppliedFilter[],
  unknown: readonly string[],
): Evaluated {
  if (node.node === 'warehouse') return unknownNode([WAREHOUSE_NODE, ...unknown]);
  const math =
    node.mathProperty === undefined
      ? {}
      : { math: { ref: node.mathProperty, path: `${path}.mathProperty` } };
  const nodeFilters = [...own(node.filters, `${path}.filters`), ...shared];
  if (node.node === 'event' || node.node === 'all-events')
    return evalMember(ctx, {
      event: node.node === 'event' ? node.event : null,
      path,
      filters: nodeFilters,
      ...math,
      unknown: [...unknown],
    });
  if (node.node === 'group') {
    if (node.operator === 'AND') return unknownNode([AND_GROUP, ...unknown]);
    return orMembers(
      node.events.map((e, m) =>
        evalMember(ctx, {
          event: e.event,
          path: `${path}.events[${m}]`,
          filters: [...own(e.filters, `${path}.events[${m}].filters`), ...nodeFilters],
          ...math,
          unknown: [...unknown],
        }),
      ),
    );
  }
  const steps = node.action.steps;
  if (steps.length === 0) return unknownNode([NO_ACTION_STEPS, ...unknown]);
  return orMembers(
    steps.map((s, m) =>
      evalMember(ctx, {
        event: s.event,
        path: `${path}.steps[${m}]`,
        filters: [...own(s.filters, `${path}.steps[${m}].filters`), ...nodeFilters],
        ...math,
        unknown: [
          ...unknown,
          ...((s.unsupported ?? []).length > 0 ? [ACTION_STEP_UNSUPPORTED] : []),
        ],
      }),
    ),
  );
}

/** Which part a not-checked entry belongs to. */
type EntryHome =
  | { at: 'tile' }
  | { at: 'filters' }
  | { at: 'series'; index: number }
  | { at: 'formulas'; path: string }
  | { at: 'exclusions'; index?: number }
  | { at: 'breakdown'; path: string }
  | { at: 'entity'; which: 'target' | 'returning' }
  | { at: 'other'; path: string };

const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}.`);

function homeOf(entry: NotChecked): EntryHome {
  const p = entry.path;
  if (p === undefined) return { at: 'tile' };
  if (p === 'filters' || p.startsWith('filters[') || p.startsWith('filters.'))
    return { at: 'filters' };
  let m = /^series\[(\d+)\](?:\.|$)/.exec(p);
  if (m !== null) return { at: 'series', index: Number(m[1]) };
  m = /^formulas(?:\[(\d+)\])?/.exec(p);
  if (m !== null)
    return { at: 'formulas', path: m[1] === undefined ? 'formulas' : `formulas[${m[1]}]` };
  m = /^exclusions(?:\[(\d+)\])?(?:\.|$)/.exec(p);
  if (m !== null)
    return m[1] === undefined ? { at: 'exclusions' } : { at: 'exclusions', index: Number(m[1]) };
  m = /^breakdown(?:\[(\d+)\])?/.exec(p);
  if (m !== null) return { at: 'breakdown', path: m[0] };
  if (under(p, 'retention.target')) return { at: 'entity', which: 'target' };
  if (under(p, 'retention.returning')) return { at: 'entity', which: 'returning' };
  return { at: 'other', path: p };
}

interface Homes {
  tile: string[];
  filters: string[];
  series: Map<number, string[]>;
  formulas: Map<string, string[]>;
  exclusions: string[];
  exclusion: Map<number, string[]>;
  breakdown: Map<string, string[]>;
  entity: Map<string, string[]>;
  other: Map<string, string[]>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function homes(entries: readonly NotChecked[], seriesCount: number): Homes {
  const h: Homes = {
    tile: [],
    filters: [],
    series: new Map(),
    formulas: new Map(),
    exclusions: [],
    exclusion: new Map(),
    breakdown: new Map(),
    entity: new Map(),
    other: new Map(),
  };
  for (const e of entries) {
    const home = homeOf(e);
    if (home.at === 'tile') h.tile.push(e.reason);
    else if (home.at === 'filters') h.filters.push(e.reason);
    else if (home.at === 'series' && home.index < seriesCount) push(h.series, home.index, e.reason);
    else if (home.at === 'series') push(h.other, e.path as string, e.reason);
    else if (home.at === 'formulas') push(h.formulas, home.path, e.reason);
    else if (home.at === 'exclusions' && home.index === undefined) h.exclusions.push(e.reason);
    else if (home.at === 'exclusions') push(h.exclusion, home.index as number, e.reason);
    else if (home.at === 'breakdown') push(h.breakdown, home.path, e.reason);
    else if (home.at === 'entity') push(h.entity, home.which, e.reason);
    else push(h.other, home.path, e.reason);
  }
  return h;
}

/**
 * The filters every value part carries: the tile's, then its dashboards'. A tile on dashboards
 * whose filter lists differ shows different data on each, so they become one unknown fact; any
 * not-checked entry on `filters` (a dropped filter, or a dashboard layer PostHog merges in a way
 * the format cannot hold, ADR-033) leaves the shared filters unchecked as a whole.
 */
function sharedFilters(
  tile: Tile,
  dashboards: Requirements['dashboards'],
  entries: readonly string[],
): { filters: AppliedFilter[]; unknown: string[] } {
  if (entries.length > 0) return { filters: [], unknown: [...entries] };
  const byId = new Map((dashboards ?? []).map((d) => [d.id, d.filters ?? []]));
  const lists = (tile.dashboards ?? []).map((id) => ({ id, filters: byId.get(id) ?? [] }));
  const first = lists.find((l) => l.filters.length > 0);
  const key = (fs: readonly Filter[]) => JSON.stringify(fs);
  const filters = own(tile.filters, 'filters');
  if (first === undefined) return { filters, unknown: [] };
  if (lists.some((l) => key(l.filters) !== key(first.filters)))
    return { filters, unknown: [DASHBOARD_FILTERS_DIFFER] };
  return {
    filters: [...filters, ...own(first.filters, `dashboards[${first.id}].filters`)],
    unknown: [],
  };
}

function part(path: string, role: PartRole, effect: PartVerdict, reasons: readonly string[] = []) {
  const out: PartResult = { path, role, effect };
  if (effect === 'unknown') out.reasons = sortedUnique(reasons);
  return out;
}

/** Trends, lifecycle and stickiness: dead when every decided part is dead (spec 6.7.3). */
function coreOf(parts: readonly PartResult[]): PartVerdict {
  const decided = parts.filter((p) => p.effect !== 'unknown');
  if (decided.length === 0) return 'unknown';
  if (decided.every((p) => p.effect === 'dead')) return 'dead';
  if (decided.some((p) => p.effect === 'dead' || p.effect === 'partly-dead')) return 'partly-dead';
  if (decided.some((p) => p.effect === 'degraded')) return 'degraded';
  return 'live';
}

function notCheckedTile(tile: Tile, reasons: readonly string[]): TileResult {
  return {
    id: tile.id,
    kind: tile.kind,
    verdict: 'not-checked',
    platforms: [],
    parts: [],
    series: [],
    findings: [],
    unknownParts: [],
    reasons: sortedUnique(reasons),
  };
}

const CHECKED_KINDS: ReadonlySet<TileKind> = new Set([
  'trends',
  'lifecycle',
  'stickiness',
  'funnels',
  'retention',
]);

function dedupe(findings: readonly CheckFinding[]): CheckFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = JSON.stringify(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface ValueParts {
  parts: PartResult[];
  core: PartVerdict;
  findings: CheckFinding[];
  liveEvents: (string | null)[];
  deadFrom?: number;
}

function seriesParts(tile: Tile, nodes: readonly Evaluated[], h: Homes): ValueParts {
  const series = tile.series ?? [];
  const formulaMode = (tile.formulas ?? []).length > 0 || h.formulas.size > 0;
  if (!formulaMode) {
    const parts = nodes.map((n, i) => part(`series[${i}]`, 'series', n.effect, n.reasons));
    return {
      parts,
      core: coreOf(parts),
      findings: nodes.flatMap((n) => n.findings),
      liveEvents: nodes.flatMap((n) => n.liveEvents),
    };
  }
  // PostHog shows only the formulas' results: the series are their inputs.
  const byRef = new Map<string, number>();
  series.forEach((s, i) => {
    if (s.ref !== undefined) byRef.set(s.ref, i);
  });
  const effects = new Map([...byRef].map(([ref, i]) => [ref, (nodes[i] as Evaluated).effect]));
  const parts: PartResult[] = [];
  const uses = new Map<number, PartVerdict[]>();
  const seen = new Set<string>();
  for (const f of tile.formulas ?? []) {
    const path = `formulas[${f.index}]`;
    seen.add(path);
    const parsed = parseFormula(f.expression);
    const refs = sortedUnique([...f.refs, ...(parsed.ok ? formulaRefs(parsed.ast) : [])]);
    const inputs = refs.flatMap((r) => (byRef.has(r) ? [byRef.get(r) as number] : []));
    const entries = h.formulas.get(path);
    const v =
      entries === undefined
        ? formulaVerdict(f.expression, effects)
        : { effect: 'unknown' as const, reasons: entries };
    const reasons = [...(v.reasons ?? [])];
    if (reasons.includes(FORMULA_SERIES_UNKNOWN))
      reasons.push(...inputs.flatMap((i) => (nodes[i] as Evaluated).reasons));
    parts.push(part(path, 'formula', v.effect, reasons));
    for (const i of inputs) push(uses, i, v.effect);
  }
  for (const [path, reasons] of h.formulas)
    if (!seen.has(path)) parts.push(part(path, 'formula', 'unknown', reasons));
  // A series finding is an info line when every formula over the series is live.
  const findings = [...uses].flatMap(([i, used]) =>
    (nodes[i] as Evaluated).findings.map((f) =>
      f.effect !== 'info' && used.every((e) => e === 'live')
        ? { ...f, effect: 'info' as const }
        : f,
    ),
  );
  const liveEvents = [...uses].flatMap(([i]) => (nodes[i] as Evaluated).liveEvents);
  return { parts, core: coreOf(parts), findings, liveEvents };
}

/** Funnels: the first dead step k gives dead (k = 1) or partly dead (k > 1, steps k to n are 0). */
function funnelParts(nodes: readonly Evaluated[]): ValueParts {
  const parts = nodes.map((n, i) => part(`series[${i}]`, 'step', n.effect, n.reasons));
  const findings = nodes.flatMap((n) => n.findings);
  const liveEvents = nodes.flatMap((n) => n.liveEvents);
  const k = nodes.findIndex((n) => n.effect === 'dead');
  if (k === 0) return { parts, core: 'dead', findings, liveEvents };
  if (k > 0) return { parts, core: 'partly-dead', findings, liveEvents, deadFrom: k + 1 };
  return { parts, core: coreOf(parts), findings, liveEvents };
}

/** Retention: a dead target is dead; a dead returning entity is partly dead (always 0%). */
function retentionParts(target: Evaluated, returning: Evaluated): ValueParts {
  const parts = [
    part('retention.target', 'entity', target.effect, target.reasons),
    part('retention.returning', 'entity', returning.effect, returning.reasons),
  ];
  const findings = [...target.findings, ...returning.findings];
  const liveEvents = [...target.liveEvents, ...returning.liveEvents];
  const core =
    target.effect === 'dead' ? 'dead' : returning.effect === 'dead' ? 'partly-dead' : coreOf(parts);
  return { parts, core, findings, liveEvents };
}

/** Exclusions: one that matches nothing has no effect on the funnel (degraded). */
function exclusionParts(
  ctx: CheckContext,
  tile: Tile,
  h: Homes,
): { parts: PartResult[]; findings: CheckFinding[] } {
  const parts: PartResult[] = [];
  const findings: CheckFinding[] = [];
  if (h.exclusions.length > 0) parts.push(part('exclusions', 'exclusion', 'unknown', h.exclusions));
  (tile.exclusions ?? []).forEach((node, k) => {
    const path = `exclusions[${k}]`;
    const n = evalNode(ctx, node, path, [], h.exclusion.get(k) ?? []);
    const effect = n.effect === 'dead' ? 'degraded' : n.effect;
    parts.push(part(path, 'exclusion', effect, n.reasons));
    for (const f of n.findings)
      findings.push(f.effect === 'dead' ? { ...f, effect: 'degraded' } : f);
  });
  for (const [k, reasons] of h.exclusion)
    if (k >= (tile.exclusions ?? []).length)
      parts.push(part(`exclusions[${k}]`, 'exclusion', 'unknown', reasons));
  return { parts, findings };
}

function breakdownParts(
  ctx: CheckContext,
  tile: Tile,
  h: Homes,
  liveEvents: readonly (string | null)[],
): { parts: PartResult[]; findings: CheckFinding[] } {
  const parts: PartResult[] = [];
  const findings: CheckFinding[] = [];
  // A `breakdown` entry: PostHog may replace the tile's breakdown (a dashboard breakdown).
  const whole = h.breakdown.get('breakdown');
  if (whole === undefined)
    (tile.breakdown ?? []).forEach((ref, i) => {
      const b = checkBreakdown(ctx, ref, liveEvents, `breakdown[${i}]`);
      parts.push(part(b.path, 'breakdown', b.effect, b.reasons ?? []));
      if (b.finding !== undefined) findings.push(b.finding);
    });
  for (const [path, reasons] of h.breakdown)
    parts.push(part(path, 'breakdown', 'unknown', reasons));
  return { parts, findings };
}

function platformsOf(ctx: CheckContext, liveEvents: readonly (string | null)[]): string[] {
  return sortedUnique(
    liveEvents.flatMap((e) => (e === null ? ctx.index.platforms : ctx.index.eventPlatforms(e))),
  );
}

/**
 * One platform (spec 6.7.3): two or more platforms in the catalogs, and the live event nodes that
 * count are fed from one and the same platform. All-events nodes and events sent on every platform
 * do not count; an event no code sends (live from PostHog only) has no known platform, so the tile
 * is not one-platform.
 */
function onePlatform(ctx: CheckContext, liveEvents: readonly (string | null)[]): boolean {
  // With one catalog platform every event is on every platform, so none counts.
  const all = ctx.index.platforms;
  const fed = new Set<string>();
  for (const e of liveEvents) {
    if (e === null) continue;
    const p = ctx.index.eventPlatforms(e);
    if (p.length === 0) return false;
    if (all.every((x) => p.includes(x))) continue;
    for (const x of p) fed.add(x);
  }
  return fed.size === 1;
}

/** The verdict of one tile (spec 6.7.3); `dashboards` are the requirements' dashboards. */
export function checkTile(
  ctx: CheckContext,
  tile: Tile,
  dashboards: Requirements['dashboards'] = [],
): TileResult {
  if (!CHECKED_KINDS.has(tile.kind))
    return notCheckedTile(tile, [
      KIND_NOT_CHECKED,
      ...(tile.notChecked ?? []).map((n) => n.reason),
    ]);
  if ((ctx.profile.notCheckedKinds ?? []).includes(tile.kind))
    return notCheckedTile(tile, [KIND_CUT]);
  const series = tile.series ?? [];
  const h = homes(tile.notChecked ?? [], series.length);
  if (h.tile.length > 0) return notCheckedTile(tile, h.tile);
  const shared = sharedFilters(tile, dashboards, h.filters);
  const node = (n: SeriesNode, path: string, extra: readonly string[]) =>
    evalNode(ctx, n, path, shared.filters, [...shared.unknown, ...extra]);
  const nodes = series.map((n, i) => node(n, `series[${i}]`, h.series.get(i) ?? []));
  let value: ValueParts;
  if (tile.kind === 'funnels') value = funnelParts(nodes);
  else if (tile.kind === 'retention') {
    const r = tile.retention;
    value =
      r === undefined
        ? { parts: [], core: 'unknown', findings: [], liveEvents: [] }
        : retentionParts(
            node(r.target, 'retention.target', h.entity.get('target') ?? []),
            node(r.returning, 'retention.returning', h.entity.get('returning') ?? []),
          );
  } else value = seriesParts(tile, nodes, h);

  const parts = [...value.parts];
  const findings = [...value.findings];
  // Modifiers change nothing on a tile that is always zero.
  if (value.core !== 'dead') {
    const mods = [exclusionParts(ctx, tile, h), breakdownParts(ctx, tile, h, value.liveEvents)];
    for (const m of mods) {
      parts.push(...m.parts);
      findings.push(...m.findings);
    }
  }
  for (const [path, reasons] of h.other) parts.push(part(path, 'other', 'unknown', reasons));

  const unknownParts = parts
    .filter((p) => p.effect === 'unknown')
    .map((p) => ({ path: p.path, reasons: p.reasons ?? [] }));
  const modifierDegraded = parts.some(
    (p) => (p.role === 'exclusion' || p.role === 'breakdown') && p.effect === 'degraded',
  );
  const platforms = platformsOf(ctx, value.liveEvents);
  let verdict: TileVerdict;
  if (value.core === 'unknown') verdict = modifierDegraded ? 'degraded' : 'not-checked';
  else if (value.core === 'dead' || value.core === 'partly-dead') verdict = value.core;
  else if (value.core === 'degraded' || modifierDegraded) verdict = 'degraded';
  else verdict = onePlatform(ctx, value.liveEvents) ? 'one-platform' : 'live';

  return {
    id: tile.id,
    kind: tile.kind,
    verdict,
    platforms,
    parts,
    series: nodes.map((n, i) => part(`series[${i}]`, 'series', n.effect, n.reasons)),
    findings: dedupe(findings),
    unknownParts,
    ...(parts.length === 0 ? { reasons: [NO_PARTS] } : {}),
    ...(value.deadFrom === undefined ? {} : { deadFrom: value.deadFrom }),
  };
}

/** Every tile of the requirements, in order. */
export function checkTiles(ctx: CheckContext, requirements: Requirements): TileResult[] {
  return requirements.tiles.map((t) => checkTile(ctx, t, requirements.dashboards));
}
