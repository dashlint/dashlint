// The alert checks (spec 6.7.2, 6.7.4) over the requirements' alerts: `alert-target-valid`, then
// `alert-can-never-fire` on the effect the verdict algebra gives the part the alert watches. An
// alert runs on the insight itself, so dashboard filters do not apply. PostHog's state and enabled
// flag are carried as read. Choices the spec leaves open: ADR-041.
import type { AlertResult, Location } from '../formats/report.js';
import type { Alert, AlertTarget, Requirements, Tile } from '../formats/requirements.js';
import { fireOnZero, isRelative } from './checks/alert-fire.js';
import { checkAlertTarget } from './checks/alert-target.js';
import type { Watched } from './checks/alert-target.js';
import { sortedUnique } from './checks/common.js';
import type { CheckContext, CheckFinding } from './checks/types.js';
import { formulaRefs, parseFormula } from './formula.js';
import { checkTile } from './verdicts.js';
import type { PartResult, TileResult } from './verdicts.js';

/** A steps funnel takes no relative condition: PostHog cannot evaluate the alert. */
export const ALERT_FUNNEL_RELATIVE = 'alert-funnel-relative';
/**
 * A funnel whose first step is always zero may give PostHog no value at all (it then skips the
 * check), so whether a lower bound fires is not known.
 */
export const ALERT_EMPTY_FUNNEL = 'alert-empty-funnel';

export interface AlertFindingDetail {
  result: 'invalid-target' | 'can-never-fire' | 'fires-every-check';
  target: AlertTarget;
  /** Invalid target: how many formula results, series or steps the insight has. */
  count?: number;
  of?: 'formulas' | 'series' | 'steps';
  condition?: string;
  bounds?: Alert['bounds'];
  /** The alert reads every breakdown row, or the whole funnel, not one part. */
  watches?: 'every-row' | 'funnel';
}

/** A report finding on an alert, without its message (T7.1 writes it). */
export interface AlertFinding {
  check: 'alert-target-valid' | 'alert-can-never-fire';
  /** The part the alert watches, such as `series[1]` or `formulas[0]`. */
  path: string;
  code: 'no';
  sites: Location[];
  detail: AlertFindingDetail;
}

export interface AlertCheckResult {
  id: string;
  name?: string;
  tile: string;
  result: AlertResult;
  /** As PostHog shows it, such as "Not firing" or "Errored"; null when not read. */
  state: string | null;
  enabled?: boolean;
  /** The part the alert watches, once the target is known. */
  path?: string;
  findings: AlertFinding[];
  /** A dead target: the tile's dead findings that make it dead. */
  causes: CheckFinding[];
  /** Not checked: the reasons, sorted. */
  reasons?: string[];
}

type Effect = 'dead' | 'producing' | 'unknown';

interface WatchedEffect {
  effect: Effect;
  reasons: string[];
  /** The series (or steps) the value is computed from. */
  inputs: number[];
  firstStepDead: boolean;
}

const producing = (e: PartResult['effect']): boolean =>
  e === 'live' || e === 'degraded' || e === 'partly-dead';

const reasonsOf = (parts: readonly PartResult[]): string[] =>
  parts.flatMap((p) => (p.effect === 'unknown' ? (p.reasons ?? []) : []));

/** A sum of parts (series, formulas, breakdown rows): always zero only when every part is. */
function allDead(parts: readonly PartResult[]): Effect {
  if (parts.every((p) => p.effect === 'dead')) return 'dead';
  return parts.some((p) => producing(p.effect)) ? 'producing' : 'unknown';
}

/** A funnel conversion: zero when any step up to it is. */
function anyDead(parts: readonly PartResult[]): Effect {
  if (parts.some((p) => p.effect === 'dead')) return 'dead';
  return parts.some((p) => p.effect === 'unknown') ? 'unknown' : 'producing';
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function watchedEffect(r: TileResult, tile: Tile, w: Watched): WatchedEffect {
  const firstStepDead = tile.kind === 'funnels' && r.series[0]?.effect === 'dead';
  const out = (parts: PartResult[], effect: Effect, inputs: number[]): WatchedEffect => ({
    effect,
    reasons: effect === 'unknown' ? reasonsOf(parts) : [],
    inputs,
    firstStepDead,
  });
  if (w.kind === 'series') {
    const p = r.series[w.index] as PartResult;
    return out([p], allDead([p]), [w.index]);
  }
  if (w.kind === 'formula') {
    const p = r.parts.find((x) => x.path === `formulas[${w.index}]`) as PartResult;
    const f = (tile.formulas ?? []).find((x) => x.index === w.index);
    const parsed = f === undefined ? undefined : parseFormula(f.expression);
    const refs = [...(f?.refs ?? []), ...(parsed?.ok === true ? formulaRefs(parsed.ast) : [])];
    const series = tile.series ?? [];
    const inputs = range(series.length).filter((i) => refs.includes(series[i]?.ref as string));
    return out([p], allDead([p]), inputs);
  }
  if (w.kind === 'every-row') {
    const core = r.parts.filter((p) => p.role === 'series' || p.role === 'formula');
    return out(core, allDead(core), range(r.series.length));
  }
  const steps = 'index' in w ? r.series.slice(0, w.index + 1) : r.series;
  return out(steps, anyDead(steps), range(steps.length));
}

const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);

/** The tile's dead findings on the watched inputs or on the filters every series carries. */
function causesOf(r: TileResult, inputs: readonly number[]): CheckFinding[] {
  return r.findings.filter(
    (f) =>
      f.effect === 'dead' &&
      (under(f.path, 'filters') || inputs.some((i) => under(f.path, `series[${i}]`))),
  );
}

function sitesOf(findings: readonly CheckFinding[]): Location[] {
  const seen = new Set<string>();
  const out: Location[] = [];
  for (const site of findings.flatMap((f) => f.sites)) {
    const key = `${site.file}:${String(site.line)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(site);
  }
  return out;
}

/**
 * Both alert checks for one alert. `tile` is its tile (undefined when it is not in the file);
 * `result` is that tile checked without dashboards, when the caller already has it.
 */
export function checkAlert(
  ctx: CheckContext,
  alert: Alert,
  tile: Tile | undefined,
  result?: TileResult,
): AlertCheckResult {
  const base = {
    id: alert.id,
    ...(alert.name === undefined ? {} : { name: alert.name }),
    tile: alert.tile,
    state: alert.state ?? null,
    ...(alert.enabled === undefined ? {} : { enabled: alert.enabled }),
  };
  const notChecked = (reasons: readonly string[], path?: string): AlertCheckResult => ({
    ...base,
    result: 'not-checked',
    ...(path === undefined ? {} : { path }),
    findings: [],
    causes: [],
    reasons: sortedUnique(reasons),
  });

  const target = checkAlertTarget(alert, tile);
  if (target.valid === 'unknown') return notChecked(target.reasons);
  const path = target.path;
  if (target.valid === 'no') {
    const detail: AlertFindingDetail = {
      result: 'invalid-target',
      target: alert.target,
      count: target.count,
      of: target.of,
    };
    return {
      ...base,
      result: 'invalid-target',
      path,
      findings: [{ check: 'alert-target-valid', path, code: 'no', sites: [], detail }],
      causes: [],
    };
  }
  if (target.watched.kind === 'funnel-step' && isRelative(alert.condition))
    return notChecked([ALERT_FUNNEL_RELATIVE], path);

  const r = result ?? checkTile(ctx, tile as Tile);
  if (r.verdict === 'not-checked' && r.parts.length === 0) return notChecked(r.reasons ?? [], path);
  const w = watchedEffect(r, tile as Tile, target.watched);
  if (w.effect === 'unknown') return notChecked(w.reasons, path);
  if (w.effect === 'producing') return { ...base, result: 'ok', path, findings: [], causes: [] };

  const fire = fireOnZero(alert);
  if (fire.result === 'unknown') return notChecked([fire.reason], path);
  if (fire.result === 'fires-every-check' && w.firstStepDead)
    return notChecked([ALERT_EMPTY_FUNNEL], path);
  const causes = causesOf(r, w.inputs);
  const watches = target.watched.kind;
  const detail: AlertFindingDetail = {
    result: fire.result,
    target: alert.target,
    condition: alert.condition,
    bounds: alert.bounds,
    ...(watches === 'every-row' || watches === 'funnel' ? { watches } : {}),
  };
  return {
    ...base,
    result: fire.result,
    path,
    findings: [{ check: 'alert-can-never-fire', path, code: 'no', sites: sitesOf(causes), detail }],
    causes,
  };
}

/** Every alert of the requirements, in order; each tile is checked once, without dashboards. */
export function checkAlerts(ctx: CheckContext, requirements: Requirements): AlertCheckResult[] {
  const tiles = new Map(requirements.tiles.map((t) => [t.id, t]));
  const results = new Map<string, TileResult>();
  return (requirements.alerts ?? []).map((alert) => {
    const tile = tiles.get(alert.tile);
    let result: TileResult | undefined;
    if (tile !== undefined) {
      result = results.get(tile.id) ?? checkTile(ctx, tile);
      results.set(tile.id, result);
    }
    return checkAlert(ctx, alert, tile, result);
  });
}
