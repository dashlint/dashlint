// PostHog alerts (`alerts/`, spec 6.3.2, 6.5.2, ADR-017, ADR-019): what each alert watches (its
// config union), its condition, which bounds exist, interval, enabled and state. Only those fields
// are read: threshold numbers, `last_value` and check history never reach the requirements (G13).
import type { Alert, AlertTarget, Tile } from '../../../formats/requirements.js';
import { isRecord, nameOf } from './common.js';

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

// A trends alert's `series_index` reads the formula results when the insight has a formula (an
// unreadable formula still counts, ADR-019).
function hasFormula(tile: Tile): boolean {
  return (
    (tile.formulas ?? []).length > 0 ||
    (tile.notChecked ?? []).some((n) => n.path?.startsWith('formulas[') === true)
  );
}

/**
 * The part an alert watches. A tile that was not read leaves an index target unknown (`other`):
 * whether it reads a series or a formula, or which step is last, depends on the insight.
 */
function targetOf(config: unknown, tile: Tile | undefined): AlertTarget {
  if (!isRecord(config)) return { kind: 'other' };
  switch (config.type) {
    case 'TrendsAlertConfig': {
      const index = count(config.series_index);
      if (index === undefined || tile === undefined) return { kind: 'other' };
      return { kind: hasFormula(tile) ? 'formula' : 'series', index };
    }
    case 'FunnelsAlertConfig': {
      // PostHog: a null step is the last step (overall conversion).
      const steps = tile?.kind === 'funnels' ? (tile.series ?? []).length : 0;
      const step = config.funnel_step;
      const index =
        step === undefined || step === null ? (steps > 0 ? steps - 1 : undefined) : count(step);
      if (index === undefined || tile === undefined) return { kind: 'other' };
      return { kind: 'funnel-step', index };
    }
    case 'HogQLAlertConfig':
      return { kind: 'hogql' };
    case 'MetricsAlertConfig':
      return { kind: 'metrics' };
    default:
      return { kind: 'other' };
  }
}

// An alert with a detector is decided by the detector, not by a threshold condition.
function conditionOf(raw: Record<string, unknown>): string {
  if (isRecord(raw.detector_config)) return 'detector';
  return (isRecord(raw.condition) ? nameOf(raw.condition.type) : undefined) ?? 'other';
}

function boundsOf(threshold: unknown): Alert['bounds'] {
  const bounds =
    isRecord(threshold) && isRecord(threshold.configuration)
      ? threshold.configuration.bounds
      : undefined;
  const has = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
  return isRecord(bounds)
    ? { lower: has(bounds.lower), upper: has(bounds.upper) }
    : { lower: false, upper: false };
}

// The tile id of an alert's insight that is not among the saved insights: from its short id.
function fallbackTile(raw: Record<string, unknown>): string | undefined {
  const insight = raw.insight;
  const short = [isRecord(insight) ? insight.short_id : undefined, raw.insight_short_id].find(
    (s): s is string => typeof s === 'string' && s !== '',
  );
  if (short !== undefined) return `insight:${short}`;
  const id = isRecord(insight) ? insight.id : insight;
  return (typeof id === 'number' && Number.isFinite(id)) || (typeof id === 'string' && id !== '')
    ? `insight:${String(id)}`
    : undefined;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The project's alerts, sorted by id. `tileOf` finds the tile id of an alert's `insight` among the
 * saved insights; an alert with no id or no insight at all is left out.
 */
export function normalizeAlerts(
  alerts: readonly unknown[],
  tiles: readonly Tile[],
  tileOf: (insight: unknown) => string | undefined,
): Alert[] {
  const byTileId = new Map(tiles.map((t) => [t.id, t]));
  const out = new Map<string, Alert>();
  for (const raw of alerts) {
    if (!isRecord(raw)) continue;
    const rawId = raw.id;
    if (!((typeof rawId === 'string' && rawId !== '') || typeof rawId === 'number')) continue;
    const id = `alert:${String(rawId)}`;
    const found = tileOf(raw.insight);
    const tile = found ?? fallbackTile(raw);
    if (tile === undefined || out.has(id)) continue;
    const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : undefined;
    const interval = nameOf(raw.calculation_interval);
    out.set(id, {
      id,
      ...(name === undefined ? {} : { name }),
      tile,
      target: targetOf(raw.config, found === undefined ? undefined : byTileId.get(found)),
      condition: conditionOf(raw),
      bounds: boundsOf(raw.threshold),
      ...(interval === undefined ? {} : { interval }),
      ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
      ...(typeof raw.state === 'string' || raw.state === null ? { state: raw.state } : {}),
    });
  }
  return [...out.values()].sort((a, b) => byCodePoint(a.id, b.id));
}
