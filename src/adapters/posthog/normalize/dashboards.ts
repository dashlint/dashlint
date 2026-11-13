// Dashboards (spec 6.5.3, ADR-033): names and property filters into `dashboards[]`, each applied to
// every tile on the dashboard. PostHog's own merge (posthog/hogql_queries/apply_dashboard_filters.py)
// does more than an AND, so where the requirements format cannot say what a tile on a dashboard
// really shows, that part of the tile is not checked: a dashboard breakdown, a tile's own
// `filters_overrides`, a tile that ignores dashboard filters, a tile with a warehouse series (PostHog
// skips dashboard properties there), and a dashboard filter on a key the tile filters too (PostHog
// drops the tile's filter when the two contradict).
import type { Filter, PropertyRef, Requirements, Tile } from '../../../formats/requirements.js';
import { NotCheckedList, breakdownOf, filtersOf, isRecord, type Raw } from './common.js';

export type Dashboard = NonNullable<Requirements['dashboards']>[number];

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function idOf(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function filterKeys(filters: readonly Filter[]): string[] {
  return filters.flatMap((f) => ('any' in f ? f.any.map((a) => a.key) : [f.key]));
}

/** Every property key a tile filters on itself: insight-level, series, members, steps, exclusions. */
function ownFilterKeys(tile: Tile): Set<string> {
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isRecord(v))
      for (const [k, child] of Object.entries(v)) {
        if (k === 'filters' && Array.isArray(child))
          filterKeys(child as Filter[]).forEach((key) => keys.add(key));
        else walk(child);
      }
  };
  walk({ ...tile, notChecked: [] });
  return keys;
}

function describe(refs: readonly PropertyRef[]): string {
  return refs.map((r) => `${r.key} (${r.scope})`).join(', ');
}

/**
 * Reads dashboard bodies (`dashboards/<id>/`), adds each dashboard to the tiles on it, and records on
 * those tiles the parts the format cannot carry. `tileIdOf` maps a dashboard tile's `insight` to the
 * id of a tile that was read; tiles of insights that were not read are skipped. Deleted dashboards
 * are left out and removed from tile lists. Returns the dashboards sorted by id.
 */
export function applyDashboards(
  bodies: readonly unknown[],
  tiles: Tile[],
  tileIdOf: (insight: unknown) => string | undefined,
): Dashboard[] {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const deleted = new Set<string>();
  const out = new Map<string, Dashboard>();
  for (const body of bodies) {
    if (!isRecord(body)) continue;
    const raw = idOf(body.id);
    if (raw === undefined) continue;
    const id = `dashboard:${raw}`;
    if (body.deleted === true) {
      deleted.add(id);
      continue;
    }
    if (out.has(id)) continue;
    const local = new NotCheckedList();
    let settings: Raw = {};
    if (isRecord(body.filters)) settings = body.filters;
    else if (body.filters !== undefined && body.filters !== null)
      local.add('filters', 'dashboard filters that are not an object are not checked');
    const filters = filtersOf(settings.properties, local, 'filters');
    const breakdown = breakdownOf(settings.breakdown_filter, local);
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : undefined;
    out.set(id, { id, ...(name === undefined ? {} : { name }), filters });

    // The dashboard's tiles with their overrides; tiles that only list the dashboard themselves.
    const members = new Map<string, Raw>();
    if (Array.isArray(body.tiles))
      for (const t of body.tiles) {
        if (!isRecord(t) || t.deleted === true) continue;
        const tileId = tileIdOf(t.insight);
        if (tileId === undefined || !byId.has(tileId)) continue;
        const overrides = isRecord(t.filters_overrides) ? t.filters_overrides : {};
        members.set(tileId, { ...members.get(tileId), ...overrides });
      }
    for (const t of tiles)
      if (t.dashboards?.includes(id) === true && !members.has(t.id)) members.set(t.id, {});

    for (const [tileId, overrides] of members) {
      const tile = byId.get(tileId) as Tile;
      tile.dashboards = [...(tile.dashboards ?? []), id];
      const notChecked = new NotCheckedList();
      notChecked.items.push(...(tile.notChecked ?? []));
      for (const item of local.items) notChecked.add(item.path, `${id}: ${item.reason}`);
      const ignores = overrides.ignoreDashboardFilters === true;
      if (ignores) {
        if (filters.length > 0 || breakdown.length > 0)
          notChecked.add('filters', `${id} filters are ignored by this tile, which is not checked`);
      } else {
        if (
          filters.length > 0 &&
          (tile.series ?? []).some((s) => s.node === 'warehouse' && s.table !== undefined)
        )
          notChecked.add(
            'filters',
            `${id} filters skip a tile with a data warehouse series, which is not checked`,
          );
        const own = ownFilterKeys(tile);
        for (const key of [...new Set(filterKeys(filters))].filter((k) => own.has(k)))
          notChecked.add(
            'filters',
            `${id} filters ${key} as the tile does; PostHog may drop the tile's filter, which is not checked`,
          );
        if (breakdown.length > 0 && (overrides.breakdown_filter ?? null) === null)
          notChecked.add(
            'breakdown',
            `${id} breaks every tile down by ${describe(breakdown)}, which is not checked`,
          );
      }
      const scratch = new NotCheckedList();
      const added = filtersOf(overrides.properties, scratch, 'filters');
      if (added.length > 0 || scratch.items.length > 0)
        notChecked.add(
          'filters',
          `${id} adds filters to this tile only${added.length > 0 ? ` (${[...new Set(filterKeys(added))].join(', ')})` : ''}, which is not checked`,
        );
      const tileBreakdown = breakdownOf(overrides.breakdown_filter, scratch);
      if (tileBreakdown.length > 0)
        notChecked.add(
          'breakdown',
          `${id} breaks this tile down by ${describe(tileBreakdown)}, which is not checked`,
        );
      tile.notChecked = notChecked.items;
    }
  }
  for (const t of tiles)
    if (t.dashboards !== undefined)
      t.dashboards = [...new Set(t.dashboards.filter((d) => !deleted.has(d)))].sort(byCodePoint);
  return [...out.values()].sort((a, b) => byCodePoint(a.id, b.id));
}
