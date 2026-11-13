// PostHog insights to `dashlint.requirements/1` tiles (spec 6.5.3, ADR-019, ADR-032). Every insight
// gives a tile: a query kind or version dashlint cannot read is a tile that is not checked with the
// kind named, never an exception.
import {
  REQUIREMENTS_SCHEMA,
  type Requirements,
  type Tile,
} from '../../../formats/requirements.js';
import type { TileKind } from '../../../formats/report.js';
import {
  NotCheckedList,
  dateRangeOf,
  isRecord,
  unknownVersion,
  type ActionLookup,
  type Raw,
} from './common.js';
import { normalizeAlerts } from './alerts.js';
import { applyDashboards } from './dashboards.js';
import { funnelsParts } from './funnels.js';
import { lifecycleParts } from './lifecycle.js';
import { retentionParts } from './retention.js';
import { stickinessParts } from './stickiness.js';
import { trendsParts } from './trends.js';

export { LATEST_QUERY_VERSIONS, type ActionLookup } from './common.js';
export { actionIdsOf, actionLookup, normalizeAction } from './actions.js';
export { normalizeAlerts } from './alerts.js';
export {
  observedEvent,
  observedOf,
  referencesOf,
  withObserved,
  type ObservedInput,
  type References,
} from './observed.js';

export interface NormalizeContext {
  /** The configured host, as the client resolved it (no trailing slash). */
  host: string;
  project: number | string;
  /** Expands an action node's steps (T5.4); without it action nodes are not checked. */
  actions?: ActionLookup;
  /**
   * Dashboard bodies (`dashboards/<id>/`, T5.3); without them `dashboards` is empty and each tile
   * keeps the dashboards its insight lists.
   */
  dashboards?: readonly unknown[];
  /** The `alerts/` results (T5.4); without them `alerts` is empty. */
  alerts?: readonly unknown[];
}

type Parts = Partial<
  Pick<
    Tile,
    'series' | 'formulas' | 'filters' | 'breakdown' | 'exclusions' | 'funnelVizType' | 'retention'
  >
>;
type Handler = (query: Raw, notChecked: NotCheckedList, actions?: ActionLookup) => Parts;

const HANDLERS: Readonly<Record<string, { kind: TileKind; parts: Handler }>> = {
  TrendsQuery: { kind: 'trends', parts: trendsParts },
  LifecycleQuery: { kind: 'lifecycle', parts: lifecycleParts },
  StickinessQuery: { kind: 'stickiness', parts: stickinessParts },
  FunnelsQuery: { kind: 'funnels', parts: funnelsParts },
  RetentionQuery: { kind: 'retention', parts: retentionParts },
};

// The tile kind of a query kind that is not read (spec 6.3.2: paths, SQL and other kinds).
const UNREAD_KINDS: Readonly<Record<string, TileKind>> = {
  PathsQuery: 'paths',
  PathsV2Query: 'paths',
  HogQLQuery: 'sql',
};

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function header(
  insight: Raw,
  ctx: NormalizeContext,
): Pick<Tile, 'id' | 'title' | 'url' | 'dashboards'> {
  const short =
    typeof insight.short_id === 'string' && insight.short_id !== ''
      ? insight.short_id
      : String(insight.id);
  const title = [insight.name, insight.derived_name].find(
    (t): t is string => typeof t === 'string' && t !== '',
  );
  const dashboards = Array.isArray(insight.dashboards)
    ? [
        ...new Set(
          insight.dashboards
            .filter((d) => typeof d === 'number' || (typeof d === 'string' && d !== ''))
            .map((d) => `dashboard:${String(d)}`),
        ),
      ].sort(byCodePoint)
    : [];
  return {
    id: `insight:${short}`,
    title: title ?? '',
    url: `${ctx.host}/project/${String(ctx.project)}/insights/${short}`,
    dashboards,
  };
}

// The lists of a kind, all empty, for a query that is not read: nothing from PostHog's defaults is
// claimed (no funnel viz type, retention entities as never-checked nodes rather than $pageview).
function emptyParts(handler: Handler): Parts {
  const parts = handler({}, new NotCheckedList());
  delete parts.funnelVizType;
  if (parts.retention !== undefined)
    parts.retention = { target: { node: 'warehouse' }, returning: { node: 'warehouse' } };
  return parts;
}

function notCheckedTile(
  head: ReturnType<typeof header>,
  kind: TileKind,
  reason: string,
  extra: Partial<Tile> = {},
): Tile {
  return { ...head, kind, ...extra, notChecked: [{ reason }] };
}

/** One saved insight as a tile. */
export function normalizeInsight(insight: Raw, ctx: NormalizeContext): Tile {
  const head = header(insight, ctx);
  const query = insight.query;
  if (!isRecord(query)) return notCheckedTile(head, 'other', 'insight has no query');
  const wrapped = query.kind === 'InsightVizNode' || query.kind === 'DataVisualizationNode';
  const source = wrapped ? query.source : query;
  const kindName = isRecord(source) && typeof source.kind === 'string' ? source.kind : undefined;
  if (!isRecord(source) || kindName === undefined)
    return notCheckedTile(
      head,
      'other',
      `query kind ${String(query.kind)} has no source kind and is not checked`,
    );
  const handler = HANDLERS[kindName];
  if (handler === undefined) {
    const kind = UNREAD_KINDS[kindName] ?? 'other';
    const reason = `query kind ${kindName} is not checked`;
    if (kind === 'sql') return notCheckedTile(head, kind, reason);
    const dateRange = dateRangeOf(source);
    return notCheckedTile(head, kind, reason, {
      ...(dateRange ? { dateRange } : {}),
      testAccountFilter: source.filterTestAccounts === true,
    });
  }
  const versionReason = unknownVersion(source, kindName);
  if (versionReason !== undefined)
    return notCheckedTile(head, handler.kind, versionReason, emptyParts(handler.parts));
  const notChecked = new NotCheckedList();
  let parts: Parts;
  try {
    parts = handler.parts(source, notChecked, ctx.actions);
  } catch (e) {
    const reason = `query kind ${kindName} could not be read (${e instanceof Error ? e.message : String(e)})`;
    return notCheckedTile(head, handler.kind, reason, emptyParts(handler.parts));
  }
  const dateRange = dateRangeOf(source);
  return {
    ...head,
    kind: handler.kind,
    ...(dateRange ? { dateRange } : {}),
    testAccountFilter: source.filterTestAccounts === true,
    ...parts,
    notChecked: notChecked.items,
  };
}

// A dashboard tile's `insight` (an object with `short_id` or `id`, or a bare id) as a lookup key.
function insightKeys(ref: unknown): string[] {
  const keys: string[] = [];
  const add = (prefix: string, v: unknown): void => {
    if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v !== ''))
      keys.push(`${prefix}:${String(v)}`);
  };
  if (isRecord(ref)) {
    add('short', ref.short_id);
    add('id', ref.id);
  } else add('id', ref);
  return keys;
}

/**
 * The requirements of a project's saved insights, dashboards and alerts, before observed data is
 * added (`withObserved`) and `pulledAt` and `tool` are stamped (T5.5). Deleted insights are left
 * out; tiles, dashboards and alerts are sorted by id (code point).
 */
export function normalizeInsights(
  insights: readonly unknown[],
  ctx: NormalizeContext,
): Requirements {
  const tileOf = new Map<string, string>();
  const tiles = insights
    .filter((i): i is Raw => isRecord(i) && i.deleted !== true)
    .map((i) => {
      const tile = normalizeInsight(i, ctx);
      for (const key of insightKeys(i)) if (!tileOf.has(key)) tileOf.set(key, tile.id);
      return tile;
    })
    .sort((a, b) => byCodePoint(a.id, b.id));
  const tileOfInsight = (ref: unknown): string | undefined =>
    insightKeys(ref)
      .map((k) => tileOf.get(k))
      .find((t) => t !== undefined);
  const dashboards = applyDashboards(ctx.dashboards ?? [], tiles, tileOfInsight);
  return {
    schema: REQUIREMENTS_SCHEMA,
    source: { platform: 'posthog', host: ctx.host, project: ctx.project, profile: 'posthog' },
    dashboards,
    tiles,
    alerts: normalizeAlerts(ctx.alerts ?? [], tiles, tileOfInsight),
  };
}
