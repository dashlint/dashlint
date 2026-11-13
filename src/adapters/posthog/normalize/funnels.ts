// `FunnelsQuery` (spec 6.5.3): steps are the series in order and a step is its index, never its
// event (the same event can be several steps); exclusions sit between two step indexes;
// `funnelVizType` is kept as information. Order type, window and attribution do not change which
// events and properties a tile needs.
import type { SeriesNode, Tile } from '../../../formats/requirements.js';
import {
  breakdownOf,
  filtersOf,
  isRecord,
  seriesNode,
  seriesOf,
  type NotCheckedList,
  type Raw,
  type SeriesOptions,
} from './common.js';

const KINDS: ReadonlySet<string> = new Set([
  'EventsNode',
  'ActionsNode',
  'FunnelsDataWarehouseNode',
  'GroupNode',
]);

// FunnelsFilter.exclusions: FunnelExclusionEventsNode or FunnelExclusionActionsNode.
const EXCLUSION_KINDS: ReadonlySet<string> = new Set(['EventsNode', 'ActionsNode']);

const VIZ = /^[a-z][a-z0-9_]*$/;

function stepIndex(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * Exclusions with their step range. One whose range cannot be read (missing, negative, or a `to`
 * that is not after `from`) is left out with an entry on `exclusions`, so the paths of the others
 * stay their positions in the output.
 */
function exclusionsOf(
  funnelsFilter: Raw,
  notChecked: NotCheckedList,
  options: SeriesOptions,
): SeriesNode[] {
  const raw = funnelsFilter.exclusions;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    notChecked.add('exclusions', 'exclusions that are not a list are not checked');
    return [];
  }
  const out: SeriesNode[] = [];
  raw.forEach((item, i) => {
    const from = isRecord(item) ? stepIndex(item.funnelFromStep) : undefined;
    const to = isRecord(item) ? stepIndex(item.funnelToStep) : undefined;
    if (from === undefined || to === undefined || to <= from) {
      const range = isRecord(item)
        ? `steps ${JSON.stringify(item.funnelFromStep ?? null)} to ${JSON.stringify(item.funnelToStep ?? null)}`
        : 'no steps';
      notChecked.add('exclusions', `exclusion ${i} with ${range} is not checked`);
      return;
    }
    const node = seriesNode(item, undefined, `exclusions[${out.length}]`, notChecked, {
      ...options,
      kinds: EXCLUSION_KINDS,
    });
    out.push({ ...node, fromStep: from, toStep: to });
  });
  return out;
}

export function funnelsParts(
  query: Raw,
  notChecked: NotCheckedList,
  actions?: SeriesOptions['actions'],
): Pick<Tile, 'series' | 'filters' | 'breakdown' | 'exclusions' | 'funnelVizType'> {
  const options: SeriesOptions = { kinds: KINDS, ...(actions ? { actions } : {}) };
  const funnelsFilter = isRecord(query.funnelsFilter) ? query.funnelsFilter : {};
  // PostHog's default is `steps` (FunnelsFilter schema); a value that is not a name is left out.
  const viz = funnelsFilter.funnelVizType ?? 'steps';
  return {
    series: seriesOf(query.series, notChecked, options),
    filters: filtersOf(query.properties, notChecked, 'filters'),
    breakdown: breakdownOf(query.breakdownFilter, notChecked),
    exclusions: exclusionsOf(funnelsFilter, notChecked, options),
    ...(typeof viz === 'string' && VIZ.test(viz) ? { funnelVizType: viz } : {}),
  };
}
