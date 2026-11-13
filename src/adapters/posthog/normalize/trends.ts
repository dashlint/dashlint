// `TrendsQuery` (spec 6.5.3): series, formulas (both forms), insight-level filters and both
// breakdown forms. `compareFilter`, display options and modifiers do not change what a tile needs.
import type { Tile } from '../../../formats/requirements.js';
import {
  breakdownOf,
  filtersOf,
  formulasOf,
  seriesOf,
  type NotCheckedList,
  type Raw,
  type SeriesOptions,
} from './common.js';

const KINDS: ReadonlySet<string> = new Set([
  'EventsNode',
  'ActionsNode',
  'DataWarehouseNode',
  'GroupNode',
]);

export function trendsParts(
  query: Raw,
  notChecked: NotCheckedList,
  actions?: SeriesOptions['actions'],
): Pick<Tile, 'series' | 'formulas' | 'filters' | 'breakdown'> {
  return {
    series: seriesOf(query.series, notChecked, { kinds: KINDS, ...(actions ? { actions } : {}) }),
    formulas: formulasOf(query.trendsFilter, notChecked),
    filters: filtersOf(query.properties, notChecked, 'filters'),
    breakdown: breakdownOf(query.breakdownFilter, notChecked),
  };
}
