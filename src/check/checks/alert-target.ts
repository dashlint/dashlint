// `alert-target-valid` (spec 6.7.2, 6.7.4): does the part an alert watches exist? PostHog counts a
// trends alert's `series_index` against the formula results when the insight has formulas, else the
// series; a steps funnel's `funnel_step` against its steps. Choices the spec leaves open: ADR-041.
import type { Alert, Tile } from '../../formats/requirements.js';

/** The alert's tile is not in the requirements. */
export const ALERT_TILE_MISSING = 'alert-tile-missing';
export const ALERT_TARGET_HOGQL = 'alert-target-hogql';
export const ALERT_TARGET_METRICS = 'alert-target-metrics';
/** `pull` could not tell what the alert watches. */
export const ALERT_TARGET_UNREAD = 'alert-target-unread';
/** The target does not fit the tile: its kind, or series against formulas. */
export const ALERT_TARGET_MISMATCH = 'alert-target-mismatch';
/** Parts of the tile were not read, so how many there are is not known. */
export const ALERT_TARGET_RANGE_UNKNOWN = 'alert-target-range-unknown';
/** A funnel view PostHog evaluates no alert on. */
export const ALERT_FUNNEL_VIEW = 'alert-funnel-view';

/**
 * What the alert reads: one series, one formula result, every breakdown row of the tile, one
 * funnel step's conversion (steps view) or the whole funnel's conversion over time (trends view).
 */
export type Watched =
  { kind: 'series' | 'formula' | 'funnel-step'; index: number } | { kind: 'every-row' | 'funnel' };

export type TargetCheck =
  | { valid: 'yes'; path: string; watched: Watched }
  | { valid: 'no'; path: string; count: number; of: 'formulas' | 'series' | 'steps' }
  | { valid: 'unknown'; reasons: string[] };

interface Positions {
  /** Indexes known to exist. */
  known: Set<number>;
  /** One more than the highest index that may exist. */
  count: number;
  /** Something unread may sit at any index. */
  open: boolean;
}

function indexesAt(tile: Tile, prefix: string): { at: number[]; bare: boolean } {
  const at: number[] = [];
  let bare = false;
  const re = new RegExp(`^${prefix}(?:\\[(\\d+)\\])?`);
  for (const n of tile.notChecked ?? []) {
    const m = n.path === undefined ? null : re.exec(n.path);
    if (m === null) continue;
    if (m[1] === undefined) bare = true;
    else at.push(Number(m[1]));
  }
  return { at, bare };
}

const wholeTileEntry = (tile: Tile): boolean =>
  (tile.notChecked ?? []).some((n) => n.path === undefined);

// Formula indexes are PostHog's formula-node positions (ADR-017); an unreadable formula still counts.
function formulaPositions(tile: Tile): Positions {
  const nc = indexesAt(tile, 'formulas');
  const known = new Set([...(tile.formulas ?? []).map((f) => f.index), ...nc.at]);
  return {
    known,
    count: known.size === 0 ? 0 : Math.max(...known) + 1,
    open: nc.bare || wholeTileEntry(tile),
  };
}

function seriesPositions(tile: Tile): Positions {
  const length = (tile.series ?? []).length;
  const nc = indexesAt(tile, 'series');
  const known = new Set(Array.from({ length }, (_, i) => i));
  return {
    known,
    count: Math.max(length, ...nc.at.map((i) => i + 1)),
    open: nc.bare || wholeTileEntry(tile),
  };
}

export function hasFormulas(tile: Tile): boolean {
  return (
    (tile.formulas ?? []).length > 0 ||
    (tile.notChecked ?? []).some((n) => n.path?.startsWith('formulas') === true)
  );
}

export function hasBreakdown(tile: Tile): boolean {
  return (
    (tile.breakdown ?? []).length > 0 ||
    (tile.notChecked ?? []).some((n) => n.path?.startsWith('breakdown') === true)
  );
}

function inRange(
  p: Positions,
  index: number,
  path: string,
  of: 'formulas' | 'series' | 'steps',
  watched: Watched,
): TargetCheck {
  if (p.known.has(index)) return { valid: 'yes', path, watched };
  if (index >= p.count && !p.open) return { valid: 'no', path, count: p.count, of };
  return { valid: 'unknown', reasons: [ALERT_TARGET_RANGE_UNKNOWN] };
}

/** `alert-target-valid` for one alert; `tile` is its tile, undefined when it is not in the file. */
export function checkAlertTarget(alert: Alert, tile: Tile | undefined): TargetCheck {
  const t = alert.target;
  if (!('index' in t)) {
    const reason = {
      hogql: ALERT_TARGET_HOGQL,
      metrics: ALERT_TARGET_METRICS,
      other: ALERT_TARGET_UNREAD,
    };
    return { valid: 'unknown', reasons: [reason[t.kind]] };
  }
  if (tile === undefined) return { valid: 'unknown', reasons: [ALERT_TILE_MISSING] };
  const mismatch: TargetCheck = { valid: 'unknown', reasons: [ALERT_TARGET_MISMATCH] };

  if (t.kind === 'funnel-step') {
    if (tile.kind !== 'funnels') return mismatch;
    const view = tile.funnelVizType ?? 'steps';
    // The trends view reads the whole funnel's conversion and ignores `funnel_step`.
    if (view === 'trends')
      return { valid: 'yes', path: `series[${t.index}]`, watched: { kind: 'funnel' } };
    if (view !== 'steps') return { valid: 'unknown', reasons: [ALERT_FUNNEL_VIEW] };
    return inRange(seriesPositions(tile), t.index, `series[${t.index}]`, 'steps', t);
  }

  if (tile.kind !== 'trends' || (t.kind === 'formula') !== hasFormulas(tile)) return mismatch;
  // With a breakdown PostHog reads every row of the result, whatever the index (ADR-041).
  const rows = (w: Watched): Watched => (hasBreakdown(tile) ? { kind: 'every-row' } : w);
  if (t.kind === 'formula')
    return inRange(formulaPositions(tile), t.index, `formulas[${t.index}]`, 'formulas', rows(t));
  return inRange(seriesPositions(tile), t.index, `series[${t.index}]`, 'series', rows(t));
}
