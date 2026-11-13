// The ignore list (spec 6.7.3, 6.8): config entries that move a tile, an alert or every tile of a
// dashboard to the "ignored" count. An entry past its `until` date prints a warning and the tile
// returns. Choices the spec leaves open are in ADR-042.
import type { Verdict } from '../formats/report.js';
import type { Requirements } from '../formats/requirements.js';
import type { AlertCheckResult } from './alerts.js';
import type { TileResult } from './verdicts.js';

export type IgnoreKind = 'tile' | 'alert' | 'dashboard';

/** One `ignore` entry, its id in the requirements' form (`insight:Ab12Cd34`, `dashboard:12`). */
export interface IgnoreEntry {
  kind: IgnoreKind;
  id: string;
  reason: string;
  /** `YYYY-MM-DD`; the entry holds through that day (UTC). */
  until?: string;
}

/** An entry past its date: it ignores nothing and the report warns. */
export const IGNORE_EXPIRED = 'ignore-expired';
/** An entry whose id names no tile, alert or dashboard of the requirements. */
export const IGNORE_UNMATCHED = 'ignore-unmatched';

export interface IgnoreWarning {
  code: typeof IGNORE_EXPIRED | typeof IGNORE_UNMATCHED;
  /** The entry's position in the config's list. */
  index: number;
  entry: IgnoreEntry;
}

/** Why a tile or alert is ignored: the entry that matched (a dashboard, its tile, or itself). */
export interface IgnoreMatch {
  index: number;
  entry: IgnoreEntry;
}

export interface IgnoredTile {
  result: TileResult;
  /** `ignored` when an entry matched, else the tile's own verdict. */
  verdict: Verdict;
  ignored?: IgnoreMatch;
}

export interface IgnoredAlert {
  result: AlertCheckResult;
  ignored?: IgnoreMatch;
}

export interface IgnoreOutcome {
  tiles: IgnoredTile[];
  alerts: IgnoredAlert[];
  warnings: IgnoreWarning[];
}

const PREFIX: Record<IgnoreKind, string> = {
  tile: 'insight:',
  alert: 'alert:',
  dashboard: 'dashboard:',
};
const KINDS = Object.keys(PREFIX) as IgnoreKind[];
const KEYS = new Set<string>([...KINDS, 'reason', 'until']);

export type IgnoreParse = { ok: true; value: IgnoreEntry[] } | { ok: false; errors: string[] };

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function idOf(kind: IgnoreKind, raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw)) return `${PREFIX[kind]}${String(raw)}`;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const s = raw.trim();
  // A bare id gets the requirements' prefix; one with a colon is taken as written.
  return s.includes(':') ? s : `${PREFIX[kind]}${s}`;
}

/**
 * The config's `ignore` list (spec 6.8): each entry names exactly one of `tile`, `alert` or
 * `dashboard`, gives a `reason`, and may give `until` as `YYYY-MM-DD`. Errors name the entry and
 * key (the CLI turns them into exit 2).
 */
export function parseIgnore(raw: unknown): IgnoreParse {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, errors: ['ignore: must be a list'] };
  const errors: string[] = [];
  const value: IgnoreEntry[] = [];
  raw.forEach((item: unknown, i) => {
    const at = `ignore[${String(i)}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push(`${at}: must be a mapping`);
      return;
    }
    const e = item as Record<string, unknown>;
    const before = errors.length;
    for (const k of Object.keys(e).sort()) if (!KEYS.has(k)) errors.push(`${at}.${k}: unknown key`);
    const named = KINDS.filter((k) => Object.hasOwn(e, k));
    if (named.length !== 1) {
      errors.push(`${at}: give exactly one of tile, alert or dashboard`);
      return;
    }
    const kind = named[0] as IgnoreKind;
    const id = idOf(kind, e[kind]);
    if (id === undefined) errors.push(`${at}.${kind}: must be a non-empty id`);
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    if (reason === '') errors.push(`${at}.reason: say why the ${kind} is ignored`);
    const until = e.until;
    if (until !== undefined && (typeof until !== 'string' || !validDate(until)))
      errors.push(`${at}.until: must be a date written YYYY-MM-DD`);
    if (errors.length > before || id === undefined) return;
    value.push({ kind, id, reason, ...(typeof until === 'string' ? { until } : {}) });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** True once the UTC date of `now` is after `until`. */
export function expired(entry: IgnoreEntry, now: Date): boolean {
  return entry.until !== undefined && now.toISOString().slice(0, 10) > entry.until;
}

/**
 * Applies the entries to checked tiles and alerts. A dashboard entry ignores every tile on that
 * dashboard; an alert on an ignored tile is ignored with it. The first matching entry is the one
 * recorded. Expired and unmatched entries come back as warnings, in config order.
 */
export function applyIgnore(
  requirements: Requirements,
  tiles: readonly TileResult[],
  alerts: readonly AlertCheckResult[],
  entries: readonly IgnoreEntry[],
  now: Date,
): IgnoreOutcome {
  const warnings: IgnoreWarning[] = [];
  const active: IgnoreMatch[] = [];
  entries.forEach((entry, index) => {
    if (expired(entry, now)) warnings.push({ code: IGNORE_EXPIRED, index, entry });
    else active.push({ index, entry });
  });

  const tileDashboards = new Map(requirements.tiles.map((t) => [t.id, t.dashboards ?? []]));
  const known: Record<IgnoreKind, Set<string>> = {
    tile: new Set(requirements.tiles.map((t) => t.id)),
    alert: new Set((requirements.alerts ?? []).map((a) => a.id)),
    dashboard: new Set([
      ...(requirements.dashboards ?? []).map((d) => d.id),
      ...requirements.tiles.flatMap((t) => t.dashboards ?? []),
    ]),
  };
  for (const m of active)
    if (!known[m.entry.kind].has(m.entry.id))
      warnings.push({ code: IGNORE_UNMATCHED, index: m.index, entry: m.entry });
  warnings.sort((a, b) => a.index - b.index);

  const tileMatch = (id: string): IgnoreMatch | undefined => {
    const on = tileDashboards.get(id) ?? [];
    return active.find(
      (m) =>
        (m.entry.kind === 'tile' && m.entry.id === id) ||
        (m.entry.kind === 'dashboard' && on.includes(m.entry.id)),
    );
  };

  const outTiles = tiles.map((result): IgnoredTile => {
    const ignored = tileMatch(result.id);
    return ignored === undefined
      ? { result, verdict: result.verdict }
      : { result, verdict: 'ignored', ignored };
  });
  const outAlerts = alerts.map((result): IgnoredAlert => {
    const ignored =
      active.find((m) => m.entry.kind === 'alert' && m.entry.id === result.id) ??
      tileMatch(result.tile);
    return ignored === undefined ? { result } : { result, ignored };
  });
  return { tiles: outTiles, alerts: outAlerts, warnings };
}
