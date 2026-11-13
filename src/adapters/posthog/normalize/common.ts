// Shared pieces of the PostHog normalisers (spec 6.5.3, ADR-019, ADR-032): series nodes, property
// filters, math, breakdowns, formulas and date ranges, turned into the canonical requirements form.
// Input is whatever PostHog stored, so every field is read defensively: a shape dashlint cannot
// represent becomes a part-level "not checked" entry (ADR-017), never an exception and never a guess.
import type { JsonScalar } from '../../../formats/catalog.js';
import type {
  ActionNode,
  Filter,
  Formula,
  NotChecked,
  PropertyFilter,
  PropertyRef,
  Scope,
  SeriesNode,
} from '../../../formats/requirements.js';

export type Raw = Record<string, unknown>;

export function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isScalar(v: unknown): v is JsonScalar {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Collects the parts of one tile that are not checked, in the order they are found. */
export class NotCheckedList {
  readonly items: NotChecked[] = [];

  add(path: string | undefined, reason: string): void {
    const item: NotChecked = path === undefined ? { reason } : { path, reason };
    if (!this.items.some((i) => i.path === item.path && i.reason === item.reason))
      this.items.push(item);
  }
}

/**
 * PostHog's latest query versions (frontend/src/queries/schema/latest-versions.json, read
 * 2026-11-13). A missing or null `version` means version 1 (posthog/schema_migrations/README.md);
 * a version above these was written by a PostHog newer than this list, so its shape is not known.
 */
export const LATEST_QUERY_VERSIONS: Readonly<Record<string, number>> = {
  TrendsQuery: 4,
  FunnelsQuery: 2,
  RetentionQuery: 2,
  LifecycleQuery: 2,
  StickinessQuery: 4,
};

/** The reason a query's version is not known, or undefined when it is. */
export function unknownVersion(query: Raw, kind: string): string | undefined {
  const latest = LATEST_QUERY_VERSIONS[kind];
  const v = query.version;
  if (latest === undefined || v === undefined || v === null) return undefined;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= latest) return undefined;
  return `query kind ${kind} version ${JSON.stringify(v)} is not checked`;
}

const SCOPES: ReadonlySet<string> = new Set([
  'event',
  'person',
  'session',
  'group',
  'cohort',
  'element',
  'feature',
  'hogql',
]);

/** A PostHog property `type` (filter, breakdown) as a requirements scope; unlisted types are `other`. */
export function scopeOf(type: unknown, fallback: Scope = 'event'): Scope {
  if (type === undefined || type === null) return fallback;
  return typeof type === 'string' && SCOPES.has(type) ? (type as Scope) : 'other';
}

// `math_property_type` holds a taxonomic group name (`event_properties`) or a bare scope
// (`session`); absent means an event property.
function mathPropertyScope(type: unknown): Scope {
  if (type === undefined || type === null) return 'event';
  if (typeof type !== 'string') return 'other';
  const bare = type.replace(/_properties$/, '');
  if (/^groups?(_\d+)?$/.test(bare)) return 'group';
  return scopeOf(bare);
}

const NAME = /^[a-z][a-z0-9_-]*$/;

/** A platform name (operator, math) in the requirements' lower-case form, or undefined. */
function nameOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const lower = v.toLowerCase();
  return NAME.test(lower) ? lower : undefined;
}

/** Series letter of the series at `index`: A to Z, then AA to ZZ (the format allows two letters). */
export function refOf(index: number): string {
  const letter = (i: number): string => String.fromCharCode(65 + i);
  return index < 26 ? letter(index) : letter(Math.floor(index / 26) - 1) + letter(index % 26);
}

export const MAX_SERIES = 26 * 27;

// ---------- property filters ----------

function propertyFilter(raw: unknown): PropertyFilter | 'empty' | string {
  if (!isRecord(raw)) return 'a property filter that is not an object';
  if (raw.type === 'empty') return 'empty';
  const scope = scopeOf(raw.type);
  const key =
    nonEmptyString(raw.key) ?? (typeof raw.key === 'number' ? String(raw.key) : undefined);
  if (key === undefined)
    return `a property filter of type ${String(raw.type ?? 'event')} with no key`;
  // PostHog reads a missing operator as `exact`; a cohort filter's default is `in` (schema).
  const op =
    raw.operator === undefined || raw.operator === null
      ? raw.type === 'cohort'
        ? 'in'
        : 'exact'
      : nameOf(raw.operator);
  if (op === undefined)
    return `property filter ${key} has operator ${JSON.stringify(raw.operator)}`;
  const value = raw.value;
  const values =
    value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  if (!values.every(isScalar)) return `property filter ${key} has a value that is not a scalar`;
  return { key, scope, op, values };
}

// A filter list or group reduced to an AND list, or a reason it cannot be.
type Reduced = { and: Filter[] } | { reason: string };

function reduce(raw: unknown, notChecked: NotCheckedList, path: string): Reduced {
  if (Array.isArray(raw)) return reduceAnd(raw, notChecked, path);
  if (isRecord(raw) && (raw.type === 'AND' || raw.type === 'OR') && Array.isArray(raw.values))
    return raw.type === 'AND'
      ? reduceAnd(raw.values, notChecked, path)
      : reduceOr(raw.values, notChecked, path);
  const one = propertyFilter(raw);
  if (one === 'empty') return { and: [] };
  if (typeof one === 'string') {
    notChecked.add(path, `${one} is not checked`);
    return { and: [] };
  }
  return { and: [one] };
}

function reduceAnd(items: unknown[], notChecked: NotCheckedList, path: string): Reduced {
  const and: Filter[] = [];
  for (const item of items) {
    const r = reduce(item, notChecked, path);
    if ('reason' in r) return r;
    and.push(...r.and);
  }
  return { and };
}

// An OR is representable when each member is one property filter (or an OR of them). A member that
// is always true (an empty filter or group) makes the whole OR true: no filter.
function reduceOr(items: unknown[], notChecked: NotCheckedList, path: string): Reduced {
  const any: PropertyFilter[] = [];
  for (const item of items) {
    const local = new NotCheckedList();
    const r = reduce(item, local, path);
    if ('reason' in r) return r;
    if (local.items.length > 0)
      return { reason: 'an OR group with a member that is not checked is not checked' };
    if (r.and.length === 0) return { and: [] };
    if (r.and.length > 1) return { reason: 'an OR of AND groups is not checked' };
    const only = r.and[0] as Filter;
    if ('any' in only) any.push(...only.any);
    else any.push(only);
  }
  if (any.length === 0) return { and: [] };
  if (any.length === 1) return { and: [any[0] as PropertyFilter] };
  return { and: [{ any }] };
}

/**
 * Property filters (a list, or a PostHog AND/OR group) as an AND list. Filters that cannot be read
 * are left out and their path is recorded as not checked.
 */
export function filtersOf(raw: unknown, notChecked: NotCheckedList, path: string): Filter[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) && !isRecord(raw)) {
    notChecked.add(path, 'property filters that are not a list are not checked');
    return [];
  }
  const r = reduce(raw, notChecked, path);
  if ('reason' in r) {
    notChecked.add(path, r.reason);
    return [];
  }
  return r.and;
}

/** A node's own `properties` and its `fixedProperties` (both AND). */
function nodeFilters(raw: Raw, notChecked: NotCheckedList, path: string): Filter[] {
  return [
    ...filtersOf(raw.properties, notChecked, path),
    ...filtersOf(raw.fixedProperties, notChecked, path),
  ];
}

// ---------- series nodes ----------

/**
 * The node kind PostHog gives an item with no `kind` (schema migration 0004, which stamps the kind
 * on stored series the same way): `table_name` a warehouse node, `nodes` a group, `id` without
 * `event` an action, anything else an event node.
 */
function kindOf(raw: Raw): string {
  if (typeof raw.kind === 'string') return raw.kind;
  if ('table_name' in raw) return 'DataWarehouseNode';
  if ('nodes' in raw) return 'GroupNode';
  if ('id' in raw && !('event' in raw)) return 'ActionsNode';
  return 'EventsNode';
}

function mathOf(
  raw: Raw,
  notChecked: NotCheckedList,
  path: string,
): { math?: string; mathProperty?: PropertyRef } {
  const out: { math?: string; mathProperty?: PropertyRef } = {};
  if (raw.math !== undefined && raw.math !== null) {
    const math = nameOf(raw.math);
    if (math === undefined)
      notChecked.add(`${path}.math`, `math ${JSON.stringify(raw.math)} is not checked`);
    else out.math = math;
    if (math === 'hogql') notChecked.add(`${path}.math`, 'a HogQL math expression is not checked');
  }
  const key = nonEmptyString(raw.math_property);
  if (key !== undefined)
    out.mathProperty = { key, scope: mathPropertyScope(raw.math_property_type) };
  return out;
}

/** A series item that cannot be represented: a never-checked node that keeps the refs in place. */
function placeholder(
  ref: string | undefined,
  notChecked: NotCheckedList,
  path: string,
  reason: string,
): SeriesNode {
  notChecked.add(path, reason);
  return ref === undefined ? { node: 'warehouse' } : { ref, node: 'warehouse' };
}

/** The action expanded from `actions/{id}/`, or undefined when it was not read (T5.4). */
export type ActionLookup = (id: number | string) => ActionNode['action'] | undefined;

export interface SeriesOptions {
  /** Node kinds allowed in this position (PostHog's union for the query kind). */
  kinds: ReadonlySet<string>;
  actions?: ActionLookup;
}

/** One series item as a requirements node with its ref (or without one, for exclusions). */
export function seriesNode(
  raw: unknown,
  ref: string | undefined,
  path: string,
  notChecked: NotCheckedList,
  options: SeriesOptions,
): SeriesNode {
  if (!isRecord(raw))
    return placeholder(ref, notChecked, path, 'a series item that is not an object is not checked');
  const kind = kindOf(raw);
  if (!options.kinds.has(kind))
    return placeholder(ref, notChecked, path, `series node kind ${kind} is not checked`);
  const base = ref === undefined ? {} : { ref };
  if (
    kind === 'DataWarehouseNode' ||
    kind === 'LifecycleDataWarehouseNode' ||
    kind === 'FunnelsDataWarehouseNode'
  ) {
    const table = nonEmptyString(raw.table_name);
    const math = nameOf(raw.math);
    return {
      ...base,
      node: 'warehouse',
      ...(table === undefined ? {} : { table }),
      ...(math === undefined ? {} : { math }),
    };
  }
  const math = mathOf(raw, notChecked, path);
  const filters = nodeFilters(raw, notChecked, `${path}.filters`);
  if (kind === 'EventsNode') {
    if (raw.event === undefined || raw.event === null)
      return { ...base, node: 'all-events', ...math, filters };
    const event = nonEmptyString(raw.event);
    if (event === undefined)
      return placeholder(
        ref,
        notChecked,
        path,
        `an event node with event ${JSON.stringify(raw.event)} is not checked`,
      );
    return { ...base, node: 'event', event, ...math, filters };
  }
  if (kind === 'ActionsNode') {
    const id =
      typeof raw.id === 'number' || nonEmptyString(raw.id) !== undefined
        ? (raw.id as number | string)
        : undefined;
    if (id === undefined)
      return placeholder(ref, notChecked, path, 'an action node with no id is not checked');
    const action = options.actions?.(id);
    if (action === undefined) {
      notChecked.add(path, `action ${String(id)} was not read`);
      const name = nonEmptyString(raw.name);
      return {
        ...base,
        node: 'action',
        action: { id, ...(name === undefined ? {} : { name }), steps: [] },
        ...math,
        filters,
      };
    }
    return { ...base, node: 'action', action, ...math, filters };
  }
  // GroupNode: members are events; any other member is not representable and leaves the group unknown.
  const operator = raw.operator === 'OR' || raw.operator === 'AND' ? raw.operator : undefined;
  if (operator === undefined)
    return placeholder(
      ref,
      notChecked,
      path,
      `a group node with operator ${JSON.stringify(raw.operator)} is not checked`,
    );
  const members = Array.isArray(raw.nodes) ? raw.nodes : [];
  const events: { event: string; filters: Filter[] }[] = [];
  members.forEach((m, j) => {
    const event = isRecord(m) && kindOf(m) === 'EventsNode' ? nonEmptyString(m.event) : undefined;
    if (event === undefined || !isRecord(m)) {
      const what = isRecord(m)
        ? kindOf(m) === 'EventsNode'
          ? 'all events'
          : kindOf(m)
        : 'not an object';
      notChecked.add(path, `group member ${j} (${what}) is not checked`);
      return;
    }
    events.push({
      event,
      filters: nodeFilters(m, notChecked, `${path}.events[${events.length}].filters`),
    });
  });
  if (events.length === 0)
    return placeholder(ref, notChecked, path, 'a group node with no event member is not checked');
  return { ...base, node: 'group', operator, events, ...math, filters };
}

/** The query's series in order, refs A, B, ... by position. */
export function seriesOf(
  raw: unknown,
  notChecked: NotCheckedList,
  options: SeriesOptions,
): SeriesNode[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    notChecked.add('series', 'series that are not a list are not checked');
    return [];
  }
  if (raw.length > MAX_SERIES) {
    notChecked.add(undefined, `${raw.length} series are more than ${MAX_SERIES}`);
    return [];
  }
  return raw.map((item, i) => seriesNode(item, refOf(i), `series[${i}]`, notChecked, options));
}

// ---------- breakdowns, formulas, date range ----------

function breakdownKey(v: unknown): string | undefined {
  return nonEmptyString(v) ?? (typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
}

/**
 * Both PostHog breakdown forms (6.5.3): `breakdowns: [{ type, property }]`, or the legacy
 * `breakdown` (a key, or a list of cohort ids) with `breakdown_type`. A filter with neither is `[]`.
 * When both are present, `breakdowns` is used.
 */
export function breakdownOf(raw: unknown, notChecked: NotCheckedList): PropertyRef[] {
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) {
    notChecked.add('breakdown', 'a breakdown filter that is not an object is not checked');
    return [];
  }
  const list = raw.breakdowns;
  if (Array.isArray(list) && list.length > 0) {
    const out: PropertyRef[] = [];
    list.forEach((b, i) => {
      const key = isRecord(b) ? breakdownKey(b.property) : undefined;
      if (key === undefined || !isRecord(b))
        notChecked.add(`breakdown[${i}]`, 'a breakdown with no property is not checked');
      else out.push({ key, scope: scopeOf(b.type) });
    });
    return out;
  }
  const legacy = raw.breakdown;
  if (legacy === undefined || legacy === null || legacy === '') return [];
  const scope = scopeOf(raw.breakdown_type);
  const keys = Array.isArray(legacy) ? legacy : [legacy];
  const out: PropertyRef[] = [];
  for (const k of keys) {
    const key = breakdownKey(k);
    if (key === undefined)
      notChecked.add('breakdown', `breakdown ${JSON.stringify(k)} is not checked`);
    else out.push({ key, scope });
  }
  return out;
}

/** Distinct series letters a formula names, sorted; undefined when it names something else. */
function formulaRefs(expression: string): string[] | undefined {
  const refs = new Set<string>();
  for (const token of expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (!/^[A-Za-z]$/.test(token)) return undefined;
    refs.add(token.toUpperCase());
  }
  return [...refs].sort();
}

/**
 * Formulas from `trendsFilter`: `formulaNodes[].formula` (PostHog: takes precedence), else the
 * `formulas` list, else the legacy `formula` string as index 0. An empty list is no formula.
 */
export function formulasOf(trendsFilter: unknown, notChecked: NotCheckedList): Formula[] {
  if (!isRecord(trendsFilter)) return [];
  const nodes = trendsFilter.formulaNodes;
  const list = trendsFilter.formulas;
  let expressions: unknown[];
  if (Array.isArray(nodes) && nodes.length > 0)
    expressions = nodes.map((n) => (isRecord(n) ? n.formula : undefined));
  else if (Array.isArray(list) && list.length > 0) expressions = list;
  else if (nonEmptyString(trendsFilter.formula) !== undefined) expressions = [trendsFilter.formula];
  else return [];
  const out: Formula[] = [];
  expressions.forEach((e, index) => {
    const expression = nonEmptyString(e);
    if (expression === undefined) {
      if (e !== undefined && e !== null && e !== '')
        notChecked.add(`formulas[${index}]`, 'a formula that is not text is not checked');
      return;
    }
    const refs = formulaRefs(expression);
    if (refs === undefined)
      notChecked.add(
        `formulas[${index}]`,
        `formula ${expression} names something other than series letters`,
      );
    out.push({ index, expression, refs: refs ?? [] });
  });
  return out;
}

/** `{ from, to }` from the query's `dateRange` (null where unset), or undefined when it has none. */
export function dateRangeOf(query: Raw): { from: string | null; to: string | null } | undefined {
  const d = query.dateRange;
  if (!isRecord(d)) return undefined;
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return { from: text(d.date_from), to: text(d.date_to) };
}
