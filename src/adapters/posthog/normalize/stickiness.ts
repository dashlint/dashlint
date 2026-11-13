// `StickinessQuery` (spec 6.5.3): series and insight-level filters; `stickinessFilter` and
// `compareFilter` only change how the result is drawn.
import type { Tile } from '../../../formats/requirements.js';
import {
  filtersOf,
  seriesOf,
  type NotCheckedList,
  type Raw,
  type SeriesOptions,
} from './common.js';

const KINDS: ReadonlySet<string> = new Set(['EventsNode', 'ActionsNode', 'DataWarehouseNode']);

export function stickinessParts(
  query: Raw,
  notChecked: NotCheckedList,
  actions?: SeriesOptions['actions'],
): Pick<Tile, 'series' | 'filters'> {
  return {
    series: seriesOf(query.series, notChecked, { kinds: KINDS, ...(actions ? { actions } : {}) }),
    filters: filtersOf(query.properties, notChecked, 'filters'),
  };
}
