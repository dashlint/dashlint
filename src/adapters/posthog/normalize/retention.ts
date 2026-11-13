// `RetentionQuery` (spec 6.5.3): the target (start) and returning entities, insight-level filters and
// breakdowns. A RetentionEntity is read as PostHog's retention runner reads it: a missing entity is
// `$pageview` (DEFAULT_ENTITY), `type: actions` (or kind ActionsNode) an action by id, an event id a
// string, and no id all events. Period, intervals and retention type do not change what a tile needs.
import type { SeriesNode, Tile } from '../../../formats/requirements.js';
import {
  breakdownOf,
  filtersOf,
  isRecord,
  scopeOf,
  seriesNode,
  type NotCheckedList,
  type Raw,
  type SeriesOptions,
} from './common.js';

const KINDS: ReadonlySet<string> = new Set(['EventsNode', 'ActionsNode', 'DataWarehouseNode']);

/** PostHog's retention default entity (retention_query_runner.py DEFAULT_ENTITY). */
const DEFAULT_ENTITY: Raw = { id: '$pageview', type: 'events' };

// A RetentionEntity in the series-node shape `seriesNode` reads, or the reason it cannot be.
function asSeriesItem(entity: Raw): Raw | string {
  const filters = { properties: entity.properties };
  if (entity.type === 'actions' || (entity.type == null && entity.kind === 'ActionsNode'))
    return { kind: 'ActionsNode', id: entity.id, name: entity.name, ...filters };
  if (entity.type === 'data_warehouse')
    return { kind: 'DataWarehouseNode', table_name: entity.table_name };
  if (entity.type != null && entity.type !== 'events')
    return `a retention entity of type ${JSON.stringify(entity.type)} is not checked`;
  if (entity.kind != null && entity.kind !== 'EventsNode')
    return `a retention entity of kind ${JSON.stringify(entity.kind)} is not checked`;
  if (entity.id === undefined || entity.id === null)
    return { kind: 'EventsNode', event: null, ...filters };
  if (typeof entity.id !== 'string')
    return `a retention event entity with id ${JSON.stringify(entity.id)} is not checked`;
  return { kind: 'EventsNode', event: entity.id, ...filters };
}

function entityNode(
  raw: unknown,
  path: string,
  notChecked: NotCheckedList,
  actions?: SeriesOptions['actions'],
): SeriesNode {
  const entity = raw === undefined || raw === null ? DEFAULT_ENTITY : raw;
  if (!isRecord(entity)) {
    notChecked.add(path, 'a retention entity that is not an object is not checked');
    return { node: 'warehouse' };
  }
  const item = asSeriesItem(entity);
  if (typeof item === 'string') {
    notChecked.add(path, item);
    return { node: 'warehouse' };
  }
  return seriesNode(item, undefined, path, notChecked, {
    kinds: KINDS,
    ...(actions ? { actions } : {}),
  });
}

export function retentionParts(
  query: Raw,
  notChecked: NotCheckedList,
  actions?: SeriesOptions['actions'],
): Pick<Tile, 'filters' | 'breakdown' | 'retention'> {
  const filter = isRecord(query.retentionFilter) ? query.retentionFilter : {};
  // Sum or average of a property: which property the tile needs is not part of the format yet.
  const aggregation = filter.aggregationType;
  const property = filter.aggregationProperty;
  if (
    (aggregation === 'sum' || aggregation === 'avg') &&
    typeof property === 'string' &&
    property !== ''
  )
    notChecked.add(
      'retention',
      `a retention ${aggregation} of ${scopeOf(filter.aggregationPropertyType)} property ${property} is not checked`,
    );
  return {
    filters: filtersOf(query.properties, notChecked, 'filters'),
    breakdown: breakdownOf(query.breakdownFilter, notChecked),
    retention: {
      target: entityNode(filter.targetEntity, 'retention.target', notChecked, actions),
      returning: entityNode(filter.returningEntity, 'retention.returning', notChecked, actions),
    },
  };
}
