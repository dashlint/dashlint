// Observed data, the third input (spec 6.5.4, T2): for every event a tile references, whether PostHog
// has a definition, when it last saw it and its enforcement; for every (event, property) a tile
// references, whether PostHog ever saw the property on that event; which referenced person
// properties PostHog knows. Facts PostHog never records stay unknown: they are left out rather
// than written as "not seen" (G15, ADR-034).
import type {
  Filter,
  Observed,
  ObservedEvent,
  PropertyRef,
  Requirements,
  SeenProperties,
  SeriesNode,
  Tile,
} from '../../../formats/requirements.js';
import { isRecord } from './common.js';

export const DEFAULT_OBSERVED_DAYS = 30;

// ---------- what the tiles reference ----------

export interface References {
  /** Event names, sorted by code point. */
  events: string[];
  /** Event-scope property keys per event, both sorted by code point. */
  eventProperties: Map<string, string[]>;
  /** Person-scope property keys, sorted by code point. */
  personProperties: string[];
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Property refs of a filter list (OR groups give each member). */
function refsOf(filters: readonly Filter[] | undefined): PropertyRef[] {
  return (filters ?? []).flatMap((f) => ('any' in f ? f.any : [f]));
}

// The events a node matches, each with the property refs that apply to it on that node alone.
function nodeEvents(node: SeriesNode): { event: string; refs: PropertyRef[] }[] {
  switch (node.node) {
    case 'event':
      return [{ event: node.event, refs: [] }];
    case 'group':
      return node.events.map((m) => ({ event: m.event, refs: refsOf(m.filters) }));
    case 'action':
      return node.action.steps.flatMap((s) =>
        s.event === null ? [] : [{ event: s.event, refs: refsOf(s.filters) }],
      );
    default:
      return [];
  }
}

function nodeRefs(node: SeriesNode): PropertyRef[] {
  if (node.node === 'warehouse') return [];
  return [...(node.mathProperty ? [node.mathProperty] : []), ...refsOf(node.filters)];
}

function nodesOf(tile: Tile): SeriesNode[] {
  return [
    ...(tile.series ?? []),
    ...(tile.exclusions ?? []),
    ...(tile.retention ? [tile.retention.target, tile.retention.returning] : []),
  ];
}

/**
 * Every event, (event, event property) and person property the tiles reference: node filters, group
 * member and action step filters, math properties, and the tile's own filters, breakdowns and the
 * filters of the dashboards it is on, which apply to every event of the tile.
 */
export function referencesOf(requirements: Pick<Requirements, 'tiles' | 'dashboards'>): References {
  const dashboardFilters = new Map(
    (requirements.dashboards ?? []).map((d) => [d.id, refsOf(d.filters)]),
  );
  const events = new Set<string>();
  const eventProps = new Map<string, Set<string>>();
  const personProps = new Set<string>();
  const person = (refs: readonly PropertyRef[]): void => {
    for (const r of refs) if (r.scope === 'person') personProps.add(r.key);
  };
  for (const tile of requirements.tiles) {
    const tileRefs = [
      ...refsOf(tile.filters),
      ...(tile.breakdown ?? []),
      ...(tile.dashboards ?? []).flatMap((d) => dashboardFilters.get(d) ?? []),
    ];
    person(tileRefs);
    for (const node of nodesOf(tile)) {
      const own = nodeRefs(node);
      person(own);
      for (const { event, refs } of nodeEvents(node)) {
        person(refs);
        events.add(event);
        const keys = eventProps.get(event) ?? new Set<string>();
        for (const r of [...tileRefs, ...own, ...refs]) if (r.scope === 'event') keys.add(r.key);
        if (keys.size > 0) eventProps.set(event, keys);
      }
    }
  }
  return {
    events: [...events].sort(byCodePoint),
    eventProperties: new Map(
      [...eventProps]
        .sort(([a], [b]) => byCodePoint(a, b))
        .map(([e, keys]) => [e, [...keys].sort(byCodePoint)]),
    ),
    personProperties: [...personProps].sort(byCodePoint),
  };
}

// ---------- what PostHog records (rust/property-defs-rs/src/types.rs, read 2026-11-13) ----------

// Names over 200 bytes are dropped before any definition is written (will_fit_in_postgres_column).
function fits(name: string): boolean {
  return Buffer.byteLength(name, 'utf8') <= 200;
}

// Events whose properties are never recorded per event: `$$plugin_metrics` has none written, and
// `$groupidentify` only records group properties.
const EVENTS_WITHOUT_EVENT_PROPERTIES: ReadonlySet<string> = new Set([
  '$$plugin_metrics',
  '$groupidentify',
]);

// Event properties that never get an (event, property) row: SKIP_PROPERTIES and
// SKIP_EVENT_PROPERTY_PREFIXES.
const SKIPPED_EVENT_PROPERTIES: ReadonlySet<string> = new Set([
  '$set',
  '$set_once',
  '$unset',
  '$group_0',
  '$group_1',
  '$group_2',
  '$group_3',
  '$group_4',
  '$groups',
]);
const SKIPPED_EVENT_PROPERTY_PREFIXES = ['$feature/', '$feature_enrollment/'];
const SKIPPED_PERSON_PROPERTY_PREFIXES = ['$device_push_subscription_'];

function recordsEventProperty(key: string): boolean {
  return (
    fits(key) &&
    !SKIPPED_EVENT_PROPERTIES.has(key) &&
    !SKIPPED_EVENT_PROPERTY_PREFIXES.some((p) => key.startsWith(p))
  );
}

function recordsPersonProperty(key: string): boolean {
  return fits(key) && !SKIPPED_PERSON_PROPERTY_PREFIXES.some((p) => key.startsWith(p));
}

// ---------- observed ----------

export interface ObservedInput {
  /** `observedDays` from the config; default 30. */
  windowDays?: number;
  /** Every page of `event_definitions/`. */
  eventDefinitions: readonly unknown[];
  /**
   * Per referenced event, every page of `property_definitions/?type=event` filtered by that event
   * (`event_names=[<event>]`); an event with no entry was not read and stays unknown.
   */
  eventProperties?: ReadonlyMap<string, readonly unknown[]>;
  /** Every page of `property_definitions/?type=person`; absent when not read. */
  personProperties?: readonly unknown[];
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/;

// `last_seen_at` as a UTC timestamp; null stays null (defined, never seen); a value that is not a
// time is left out (unknown).
function lastSeenOf(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  if (TIMESTAMP.test(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(v) ? undefined : new Date(t).toISOString();
}

function definitionsByName(list: readonly unknown[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const d of list)
    if (isRecord(d) && typeof d.name === 'string' && !out.has(d.name)) out.set(d.name, d);
  return out;
}

function eventFact(def: Record<string, unknown> | undefined): ObservedEvent {
  if (def === undefined) return { defined: false };
  const lastSeenAt = lastSeenOf(def.last_seen_at);
  const mode = def.enforcement_mode;
  return {
    defined: true,
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    ...(mode === 'allow' || mode === 'reject' ? { enforcement: mode } : {}),
  };
}

// Filtered by one event, PostHog marks each definition with `is_seen_on_filtered_events`; a key
// with no definition in the list was never seen on the event. A mark that is neither true nor
// false says nothing, so the key is left out of both lists.
function seenOnEvent(keys: readonly string[], list: readonly unknown[]): SeenProperties {
  const defs = definitionsByName(list);
  const seen: string[] = [];
  const notSeen: string[] = [];
  for (const key of keys) {
    const def = defs.get(key);
    if (def === undefined || def.is_seen_on_filtered_events === false) notSeen.push(key);
    else if (def.is_seen_on_filtered_events === true) seen.push(key);
  }
  return { seen, notSeen };
}

/** The observed data for the events and properties the requirements reference. */
export function observedOf(
  requirements: Pick<Requirements, 'tiles' | 'dashboards'>,
  input: ObservedInput,
): Observed {
  const windowDays = input.windowDays ?? DEFAULT_OBSERVED_DAYS;
  if (!Number.isInteger(windowDays) || windowDays < 1)
    throw new RangeError(`observedDays must be a whole number of days, at least 1 (${windowDays})`);
  const refs = referencesOf(requirements);
  const defs = definitionsByName(input.eventDefinitions);
  // Built with fromEntries so an event named `__proto__` is an own key like any other.
  const events: Record<string, ObservedEvent> = Object.fromEntries(
    refs.events.filter(fits).map((event) => [event, eventFact(defs.get(event))]),
  );
  const eventProperties: Record<string, SeenProperties> = Object.fromEntries(
    [...refs.eventProperties].flatMap(([event, keys]) => {
      const list = input.eventProperties?.get(event);
      const recorded = keys.filter(recordsEventProperty);
      if (list === undefined || recorded.length === 0 || !fits(event)) return [];
      if (EVENTS_WITHOUT_EVENT_PROPERTIES.has(event)) return [];
      return [[event, seenOnEvent(recorded, list)]];
    }),
  );
  let personProperties: SeenProperties | undefined;
  if (input.personProperties !== undefined) {
    const known = definitionsByName(input.personProperties);
    const keys = refs.personProperties.filter(recordsPersonProperty);
    personProperties = {
      seen: keys.filter((k) => known.has(k)),
      notSeen: keys.filter((k) => !known.has(k)),
    };
  }
  return {
    windowDays,
    events,
    ...(Object.keys(eventProperties).length > 0 ? { eventProperties } : {}),
    ...(personProperties === undefined ? {} : { personProperties }),
  };
}

/** The requirements with `observed` filled from PostHog's definitions. */
export function withObserved(requirements: Requirements, input: ObservedInput): Requirements {
  return { ...requirements, observed: observedOf(requirements, input) };
}

/**
 * Whether PostHog saw an event inside the window ending at `at` (the pull time): yes when its
 * `lastSeenAt` is inside the last `windowDays` days, no when it is not defined or was last seen
 * earlier, unknown when `observed` is absent, the event was not read, or the time is not known.
 */
export function observedEvent(
  observed: Observed | undefined,
  event: string,
  at: string | Date,
): 'yes' | 'no' | 'unknown' {
  if (observed === undefined || !Object.hasOwn(observed.events, event)) return 'unknown';
  const fact = observed.events[event] as ObservedEvent;
  if (!fact.defined) return 'no';
  if (typeof fact.lastSeenAt !== 'string') return 'unknown';
  const seen = Date.parse(fact.lastSeenAt);
  const end = typeof at === 'string' ? Date.parse(at) : at.getTime();
  if (Number.isNaN(seen) || Number.isNaN(end)) return 'unknown';
  return seen >= end - observed.windowDays * 86_400_000 ? 'yes' : 'no';
}
