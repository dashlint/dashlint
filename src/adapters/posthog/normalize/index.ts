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
import { lifecycleParts } from './lifecycle.js';
import { stickinessParts } from './stickiness.js';
import { trendsParts } from './trends.js';

export { LATEST_QUERY_VERSIONS, type ActionLookup } from './common.js';

export interface NormalizeContext {
  /** The configured host, as the client resolved it (no trailing slash). */
  host: string;
  project: number | string;
  /** Expands an action node's steps (T5.4); without it action nodes are not checked. */
  actions?: ActionLookup;
}

type Parts = Partial<Pick<Tile, 'series' | 'formulas' | 'filters' | 'breakdown'>>;
type Handler = (query: Raw, notChecked: NotCheckedList, actions?: ActionLookup) => Parts;

const HANDLERS: Readonly<Record<string, { kind: TileKind; parts: Handler }>> = {
  TrendsQuery: { kind: 'trends', parts: trendsParts },
  LifecycleQuery: { kind: 'lifecycle', parts: lifecycleParts },
  StickinessQuery: { kind: 'stickiness', parts: stickinessParts },
};

// The tile kind of a query kind that is not (yet) read.
const UNREAD_KINDS: Readonly<Record<string, TileKind>> = {
  FunnelsQuery: 'funnels',
  RetentionQuery: 'retention',
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
    return notCheckedTile(
      head,
      handler.kind,
      versionReason,
      handler.parts({}, new NotCheckedList()),
    );
  const notChecked = new NotCheckedList();
  let parts: Parts;
  try {
    parts = handler.parts(source, notChecked, ctx.actions);
  } catch (e) {
    const reason = `query kind ${kindName} could not be read (${e instanceof Error ? e.message : String(e)})`;
    return notCheckedTile(head, handler.kind, reason, handler.parts({}, new NotCheckedList()));
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

/**
 * The requirements of a project's saved insights, before dashboards, alerts and observed data are
 * added (T5.3, T5.4) and `pulledAt` and `tool` are stamped (T5.5). Deleted insights are left out;
 * tiles are sorted by id (code point).
 */
export function normalizeInsights(
  insights: readonly unknown[],
  ctx: NormalizeContext,
): Requirements {
  const tiles = insights
    .filter((i): i is Raw => isRecord(i) && i.deleted !== true)
    .map((i) => normalizeInsight(i, ctx))
    .sort((a, b) => byCodePoint(a.id, b.id));
  return {
    schema: REQUIREMENTS_SCHEMA,
    source: { platform: 'posthog', host: ctx.host, project: ctx.project, profile: 'posthog' },
    dashboards: [],
    tiles,
    alerts: [],
  };
}
