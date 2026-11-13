// `dashlint.requirements/1` (spec 6.3.2): what the dashboards of one analytics project need. The
// JSON Schema in schema/requirements.schema.json is the contract (canonical form, YAML shorthands
// already expanded); these types mirror it.
import type { JsonScalar } from './catalog.js';
import type { TileKind } from './report.js';

export const REQUIREMENTS_SCHEMA = 'dashlint.requirements/1';

export type Scope =
  'event' | 'person' | 'session' | 'group' | 'cohort' | 'element' | 'feature' | 'hogql' | 'other';

/** A property by key and scope: a math property or a breakdown. */
export interface PropertyRef {
  key: string;
  scope: Scope;
}

export interface PropertyFilter {
  key: string;
  scope: Scope;
  /** The platform's operator, such as `exact`, `is_not` or `icontains`. */
  op: string;
  /** Always a list; JSON types are kept. */
  values: JsonScalar[];
}

/** OR of its members. */
export interface AnyFilter {
  any: PropertyFilter[];
}

/** A list of filters is an AND of its items. */
export type Filter = PropertyFilter | AnyFilter;

interface NodeBase {
  /** Series letter (A, B, ...) in query order; on series and funnel steps only. */
  ref?: string;
  /** Funnel exclusions only: the step indexes the exclusion sits between. */
  fromStep?: number;
  toStep?: number;
  math?: string;
}

export interface EventNode extends NodeBase {
  node: 'event';
  event: string;
  mathProperty?: PropertyRef;
  filters?: Filter[];
}

export interface GroupNode extends NodeBase {
  node: 'group';
  /** An AND group is not checked. */
  operator: 'OR' | 'AND';
  events: { event: string; filters?: Filter[] }[];
  mathProperty?: PropertyRef;
  filters?: Filter[];
}

export interface AllEventsNode extends NodeBase {
  node: 'all-events';
  mathProperty?: PropertyRef;
  filters?: Filter[];
}

export interface ActionStep {
  /** null matches every event. */
  event: string | null;
  filters?: Filter[];
  /** Matchers dashlint cannot check (url, selector, text, ...): the step is unknown. */
  unsupported?: string[];
}

export interface ActionNode extends NodeBase {
  node: 'action';
  action: { id: number | string; name?: string; steps: ActionStep[] };
  mathProperty?: PropertyRef;
  filters?: Filter[];
}

/** Never checked. */
export interface WarehouseNode extends NodeBase {
  node: 'warehouse';
  table?: string;
}

export type SeriesNode = EventNode | GroupNode | AllEventsNode | ActionNode | WarehouseNode;

export type NodeKind = SeriesNode['node'];

export interface Formula {
  /** The formula node's index in the query; alert formula targets use it. */
  index: number;
  expression: string;
  refs: string[];
}

export interface NotChecked {
  /** The part, such as `series[1]`; absent means the whole tile. */
  path?: string;
  reason: string;
}

export interface Tile {
  id: string;
  title: string;
  url?: string;
  dashboards?: string[];
  kind: TileKind;
  dateRange?: { from?: string | null; to?: string | null };
  /** Information only: a person-level filter dashlint does not check. */
  testAccountFilter?: boolean;
  /** Series, or funnel steps in order (a step is its index, never its event). */
  series?: SeriesNode[];
  formulas?: Formula[];
  /** Apply to every series (AND). */
  filters?: Filter[];
  breakdown?: PropertyRef[];
  /** Funnels only. */
  exclusions?: SeriesNode[];
  funnelVizType?: string;
  /** Retention only; an entity with no event is all events. */
  retention?: { target: SeriesNode; returning: SeriesNode };
  notChecked?: NotChecked[];
}

export type AlertTarget =
  | { kind: 'series' | 'formula' | 'funnel-step'; index: number }
  | { kind: 'hogql' | 'metrics' | 'other' };

export interface Alert {
  id: string;
  name?: string;
  tile: string;
  target: AlertTarget;
  /** Such as `relative_decrease` or `absolute_value`. */
  condition: string;
  /** Which bounds exist; threshold values are never stored. */
  bounds: { lower: boolean; upper: boolean };
  interval?: string;
  enabled?: boolean;
  /** As the platform shows it, such as "Not firing" or "Errored". */
  state?: string | null;
}

export interface ObservedEvent {
  defined: boolean;
  lastSeenAt?: string | null;
  enforcement?: 'allow' | 'reject';
}

export interface SeenProperties {
  seen: string[];
  notSeen: string[];
}

export interface Observed {
  windowDays: number;
  events: Record<string, ObservedEvent>;
  eventProperties?: Record<string, SeenProperties>;
  personProperties?: SeenProperties;
}

export interface Requirements {
  schema: typeof REQUIREMENTS_SCHEMA;
  source: {
    platform: string;
    host?: string;
    project?: number | string;
    pulledAt?: string;
    tool?: string;
    profile?: 'posthog' | 'generic';
    note?: string;
  };
  dashboards?: { id: string; name?: string; filters?: Filter[] }[];
  tiles: Tile[];
  alerts?: Alert[];
  /** Absent: checks are code only and the report header says so. */
  observed?: Observed;
}
