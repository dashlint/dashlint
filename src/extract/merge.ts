// Catalog merge (spec 6.4 item 11, T4.1): web and mobile, and other repos, give one view per event.
// Super properties and builtins are applied per source first, since `register` in one source never
// reaches another source's events. Then events merge by name: sites and platforms are unioned, a
// property is `always` only when every site in every catalog sends it always, and any open site
// keeps "no" facts unknown (G15).
import type { Descriptor, UnknownNames } from '../descriptors/index.js';
import {
  MIN_NAME_RESOLUTION_RATE,
  type CallSite,
  type Catalog,
  type EventSite,
  type OpenWorldSite,
  type Presence,
  type PropertyFact,
  type ValueDomain,
} from '../formats/catalog.js';
import { mergeSiteProperties, unionDomains, type PropertyFactValue } from './properties.js';

export { MIN_NAME_RESOLUTION_RATE };

/** One SDK's builtins table, whatever each row's condition (the catalog says which were not sent). */
export interface BuiltinTable {
  events: string[];
  properties: { name: string; events: '*' | string[]; presence: Presence }[];
  personProperties: string[];
  unknownNames: UnknownNames;
}

/** Tables by SDK id; a catalog names them `<sdk>@<major>` in `builtins.properties`. */
export type BuiltinTables = ReadonlyMap<string, BuiltinTable>;

export function builtinTables(descriptors: readonly Descriptor[]): BuiltinTables {
  return new Map(
    descriptors.map((d) => [
      d.sdk,
      {
        events: d.builtins.events.map((b) => b.name),
        properties: d.builtins.properties.map((b) => ({
          name: b.name,
          events: b.events,
          presence: b.presence,
        })),
        personProperties: d.builtins.personProperties.map((b) => b.name),
        unknownNames: d.unknownNames ?? {},
      },
    ]),
  );
}

export interface MergedSource {
  /** The catalog as given. */
  catalog: Catalog;
  /** Tables the catalog names that this version does not know: its builtins stay unknown. */
  unknownTables: string[];
  /** Name prefixes no builtin row can be cited for (ADR-003), from the source's tables. */
  unknownNames: Required<UnknownNames>;
}

/** A site with the index of its catalog in `MergedCatalogs.sources`. */
export interface MergedSite extends EventSite {
  source: number;
}

export interface MergedEvent {
  /** Sources that send the event, by a call site or as a builtin event; ascending. */
  senders: number[];
  /** By source, then file and line. */
  sites: MergedSite[];
  /** Sites whose properties are open, in every catalog. */
  openSites: number;
  /** Own, super and builtin properties applied per source, then merged across the senders. */
  properties: Record<string, PropertyFact>;
  /** Every platform a site or a builtin sender feeds; sorted. */
  platforms: string[];
}

export interface MergedPersonProperty {
  sites: (CallSite & { source: number })[];
}

export interface MergedCatalogs {
  /** In the order given. */
  sources: MergedSource[];
  /** Every source's platforms; sorted. */
  platforms: string[];
  /** Every catalog's open world, `file-error` entries included, by source. */
  openWorld: (OpenWorldSite & { source: number })[];
  /** Sorted by code point. */
  events: Record<string, MergedEvent>;
  /** Code and sent builtin person properties; sorted by code point. */
  personProperties: Record<string, MergedPersonProperty>;
}

/** Why a fact is unknown (or why an event fact cannot be "no"). */
export type UnknownReason =
  | 'no-catalog'
  | 'open-event-name'
  | 'low-name-resolution'
  | 'conditional-builtin'
  | 'unknown-builtin-table'
  | 'uncitable-name'
  | 'event-not-sent'
  | 'open-properties'
  | 'open-super-properties'
  | 'open-person-properties'
  | 'crashed-file';

export interface CodeFact {
  fact: PropertyFactValue;
  /** Sorted; empty unless the fact is unknown. */
  unknown: UnknownReason[];
}

export interface EventCodeFact extends CodeFact {
  /** Platforms that send the event; empty unless "yes". */
  platforms: string[];
}

export interface PropertyCodeFact extends CodeFact {
  /** The merged fact when "yes". */
  property?: PropertyFact;
  /**
   * "yes" only, sorted: why a write the catalogs do not list may also send the property, so a
   * finite `values` set may be incomplete. The same reasons that keep a "no" unknown.
   */
  incomplete?: UnknownReason[];
}

const OPEN_UNKNOWN: ValueDomain = { kind: 'open', type: 'unknown' };

/** One unit `mergeSiteProperties` merges: a site, an SDK's table rows or a source's event. */
interface Unit {
  properties: Record<string, PropertyFact>;
  openProperties: boolean;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCodePoint);
}

/** The SDK id of a table name such as `posthog-js@1`. */
function tableSdk(table: string): string {
  const at = table.lastIndexOf('@');
  return at > 0 ? table.slice(0, at) : table;
}

function tableNames(c: Catalog): string[] {
  return c.builtins.properties === null ? [] : c.builtins.properties.split(' ').filter(Boolean);
}

function mergedSource(catalog: Catalog, tables: BuiltinTables): MergedSource {
  const unknownTables: string[] = [];
  const unknownNames: Required<UnknownNames> = { events: [], properties: [], personProperties: [] };
  for (const name of tableNames(catalog)) {
    const table = tables.get(tableSdk(name));
    if (!table) {
      unknownTables.push(name);
      continue;
    }
    unknownNames.events.push(...(table.unknownNames.events ?? []));
    unknownNames.properties.push(...(table.unknownNames.properties ?? []));
    unknownNames.personProperties.push(...(table.unknownNames.personProperties ?? []));
  }
  return {
    catalog,
    unknownTables: sorted(unknownTables),
    unknownNames: {
      events: sorted(unknownNames.events),
      properties: sorted(unknownNames.properties),
      personProperties: sorted(unknownNames.personProperties),
    },
  };
}

/** Builtin property rows of the SDKs that send `event` in one source, not turned off or undecided. */
function builtinProperties(
  c: Catalog,
  event: string,
  sdks: readonly string[],
  tables: BuiltinTables,
): Record<string, PropertyFact> {
  const skip = new Set([...(c.builtins.off ?? []), ...c.builtins.conditional]);
  // Only the tables the catalog names: an SDK with no table there has no builtins.
  const named = new Set(tableNames(c).map(tableSdk));
  const known = sdks.flatMap((sdk) => {
    const table = named.has(sdk) ? tables.get(sdk) : undefined;
    return table ? [table] : [];
  });
  // Each SDK sending the event is one unit: `always` only when every one of them sends it always.
  const units = known.map((table) => ({
    openProperties: false,
    properties: Object.fromEntries(
      table.properties
        .filter((p) => !skip.has(p.name) && (p.events === '*' || p.events.includes(event)))
        .map((p): [string, PropertyFact] => [
          p.name,
          { presence: p.presence, values: OPEN_UNKNOWN },
        ]),
    ),
  }));
  return units.length > 0 ? mergeSiteProperties(units).properties : {};
}

/** Two facts about one source's event: present in either, `always` when either says always. */
function overlay(
  base: Record<string, PropertyFact>,
  extra: Record<string, PropertyFact>,
): Record<string, PropertyFact> {
  const out = new Map(Object.entries(base));
  for (const [name, fact] of Object.entries(extra)) {
    const own = out.get(name);
    out.set(
      name,
      own
        ? {
            presence:
              own.presence === 'always' || fact.presence === 'always' ? 'always' : 'sometimes',
            values: unionDomains(own.values, fact.values),
          }
        : fact,
    );
  }
  return Object.fromEntries([...out].sort(([a], [b]) => byCodePoint(a, b)));
}

/**
 * One source's facts about one event, before the merge: its sites' properties (with a builtin send
 * counted as one more site that sends none of them), then its super properties (`sometimes`), then
 * the builtin rows of the SDKs that send the event.
 */
function sourceEventProperties(
  c: Catalog,
  event: string,
  builtinSdks: readonly string[] | undefined,
  tables: BuiltinTables,
): Record<string, PropertyFact> {
  const own = Object.hasOwn(c.events, event) ? c.events[event] : undefined;
  const units: Unit[] = [];
  if (own) units.push({ properties: own.properties, openProperties: false });
  if (builtinSdks) units.push({ properties: {}, openProperties: false });
  let properties = units.length > 0 ? mergeSiteProperties(units).properties : {};
  properties = overlay(
    properties,
    Object.fromEntries(
      Object.entries(c.superProperties).map(([name, s]): [string, PropertyFact] => [
        name,
        { presence: 'sometimes', values: s.values },
      ]),
    ),
  );
  const sdks = sorted([...(own?.sites.map((s) => s.sdk) ?? []), ...(builtinSdks ?? [])]);
  return overlay(properties, builtinProperties(c, event, sdks, tables));
}

/** The SDKs whose tables list a builtin event the source sends; all its tables when none does. */
function builtinEventSdks(c: Catalog, event: string, tables: BuiltinTables): string[] {
  const sdks = tableNames(c).map(tableSdk);
  const listing = sdks.filter((sdk) => tables.get(sdk)?.events.includes(event));
  return listing.length > 0 ? listing : sdks;
}

/**
 * Merges catalogs by event (spec 6.4 item 11). Facts come from `eventFact`, `propertyFact` and
 * `personPropertyFact`; the result does not depend on the order of `catalogs` except for source
 * indices.
 */
export function mergeCatalogs(catalogs: readonly Catalog[], tables: BuiltinTables): MergedCatalogs {
  const sources = catalogs.map((c) => mergedSource(c, tables));
  const names = new Set<string>();
  for (const c of catalogs) {
    for (const name of Object.keys(c.events)) names.add(name);
    for (const name of c.builtins.events) names.add(name);
  }
  const events = new Map<string, MergedEvent>();
  for (const name of sorted(names)) {
    const senders: number[] = [];
    const sites: MergedSite[] = [];
    const platforms = new Set<string>();
    const perSource: Unit[] = [];
    let openSites = 0;
    catalogs.forEach((c, source) => {
      const own = Object.hasOwn(c.events, name) ? c.events[name] : undefined;
      const builtin = c.builtins.events.includes(name);
      if (!own && !builtin) return;
      senders.push(source);
      if (own) {
        openSites += own.openSites;
        for (const site of own.sites) {
          sites.push({ ...site, via: [...site.via], platforms: [...site.platforms], source });
          for (const p of site.platforms) platforms.add(p);
        }
      }
      if (builtin) for (const p of c.source.platforms) platforms.add(p);
      perSource.push({
        properties: sourceEventProperties(
          c,
          name,
          builtin ? builtinEventSdks(c, name, tables) : undefined,
          tables,
        ),
        openProperties: false,
      });
    });
    events.set(name, {
      senders,
      sites,
      openSites,
      properties: mergeSiteProperties(perSource).properties,
      platforms: sorted(platforms),
    });
  }

  const person = new Map<string, MergedPersonProperty>();
  const personEntry = (name: string): MergedPersonProperty => {
    const entry = person.get(name) ?? { sites: [] };
    person.set(name, entry);
    return entry;
  };
  catalogs.forEach((c, source) => {
    for (const [name, p] of Object.entries(c.personProperties))
      personEntry(name).sites.push(...p.sites.map((s) => ({ ...s, source })));
    const skip = new Set([...(c.builtins.off ?? []), ...c.builtins.conditional]);
    for (const table of tableNames(c)) {
      for (const name of tables.get(tableSdk(table))?.personProperties ?? [])
        if (!skip.has(name)) personEntry(name);
    }
  });

  return {
    sources,
    platforms: sorted(catalogs.flatMap((c) => c.source.platforms)),
    openWorld: catalogs.flatMap((c, source) => c.openWorld.map((o) => ({ ...o, source }))),
    events: Object.fromEntries(events),
    personProperties: Object.fromEntries([...person].sort(([a], [b]) => byCodePoint(a, b))),
  };
}

function hasPrefix(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => name.startsWith(p));
}

/** Whether an open site's fixed head and tail rule `name` out (ADR-061); a plain one never does. */
function cannotSend(o: OpenWorldSite, name: string): boolean {
  if (o.kind !== 'event-name') return false;
  const { prefix = '', suffix = '' } = o;
  return (
    name.length < prefix.length + suffix.length ||
    !name.startsWith(prefix) ||
    !name.endsWith(suffix)
  );
}

/** The open sites of a catalog that may send `name`: every one but those whose bounds rule it out. */
function openSitesFor(c: Catalog, name: string): number {
  return c.coverage.openSites - c.openWorld.filter((o) => cannotSend(o, name)).length;
}

function unknown(reasons: Iterable<UnknownReason>): UnknownReason[] {
  return [...new Set(reasons)].sort(byCodePoint);
}

/**
 * Whether the code sends an event (spec 6.3.1): "yes" with a site or as a sent builtin in any
 * catalog; "no" only when every catalog is closed (no open event-name site that may send it, no
 * crashed file, at least 70% of names resolved, D9) and no builtin of any catalog may send it;
 * otherwise "unknown". An open template site may send only names with its fixed head and tail
 * (ADR-061).
 */
export function eventFact(m: MergedCatalogs, name: string): EventCodeFact {
  const event = Object.hasOwn(m.events, name) ? m.events[name] : undefined;
  if (event) return { fact: 'yes', unknown: [], platforms: [...event.platforms] };
  const reasons: UnknownReason[] = [];
  if (m.sources.length === 0) reasons.push('no-catalog');
  for (const { catalog: c, unknownTables, unknownNames } of m.sources) {
    if (openSitesFor(c, name) > 0) reasons.push('open-event-name');
    if ((c.coverage.crashedFiles ?? 0) > 0) reasons.push('crashed-file');
    if (c.coverage.nameResolutionRate < MIN_NAME_RESOLUTION_RATE)
      reasons.push('low-name-resolution');
    if (c.builtins.conditional.includes(name)) reasons.push('conditional-builtin');
    if (unknownTables.length > 0) reasons.push('unknown-builtin-table');
    if (hasPrefix(name, unknownNames.events)) reasons.push('uncitable-name');
  }
  return reasons.length > 0
    ? { fact: 'unknown', unknown: unknown(reasons), platforms: [] }
    : { fact: 'no', unknown: [], platforms: [] };
}

/**
 * Whether the code sends a property on an event (spec 6.3.1 and 6.4 item 11): "yes" when any
 * sender's own sites, super properties or builtins send it; "no" only when no site of the event is
 * open in any catalog, no sender has an open super property call, an unknown builtins table, an
 * undecided or uncitable builtin of that name, and no catalog has a crashed file (it may hold a
 * site of the event); otherwise "unknown". An event no catalog sends has no property facts. A "yes"
 * carries the same reasons as `incomplete`: its values may not be all the code sends.
 */
export function propertyFact(m: MergedCatalogs, event: string, name: string): PropertyCodeFact {
  const merged = Object.hasOwn(m.events, event) ? m.events[event] : undefined;
  if (!merged) return { fact: 'unknown', unknown: ['event-not-sent'] };
  const reasons: UnknownReason[] = [];
  if (merged.openSites > 0) reasons.push('open-properties');
  for (const { catalog: c } of m.sources)
    if ((c.coverage.crashedFiles ?? 0) > 0) reasons.push('crashed-file');
  for (const source of merged.senders) {
    const { catalog: c, unknownTables, unknownNames } = m.sources[source] as MergedSource;
    if ((c.coverage.openSuperSites ?? 0) > 0) reasons.push('open-super-properties');
    if (c.builtins.conditional.includes(name)) reasons.push('conditional-builtin');
    if (unknownTables.length > 0) reasons.push('unknown-builtin-table');
    if (hasPrefix(name, unknownNames.properties)) reasons.push('uncitable-name');
  }
  if (Object.hasOwn(merged.properties, name)) {
    const p = merged.properties[name] as PropertyFact;
    return {
      fact: 'yes',
      unknown: [],
      property: { presence: p.presence, values: p.values },
      ...(reasons.length > 0 ? { incomplete: unknown(reasons) } : {}),
    };
  }
  return reasons.length > 0
    ? { fact: 'unknown', unknown: unknown(reasons) }
    : { fact: 'no', unknown: [] };
}

/**
 * Whether the code sets a person property: "yes" when any catalog sets it or a sent builtin does;
 * "no" only when no catalog has an open person property call, a crashed file, an unknown builtins
 * table or an undecided or uncitable builtin of that name; otherwise "unknown". Persons are shared
 * by every source, so every catalog counts.
 */
export function personPropertyFact(m: MergedCatalogs, name: string): CodeFact {
  if (Object.hasOwn(m.personProperties, name)) return { fact: 'yes', unknown: [] };
  const reasons: UnknownReason[] = [];
  if (m.sources.length === 0) reasons.push('no-catalog');
  for (const { catalog: c, unknownTables, unknownNames } of m.sources) {
    if ((c.coverage.openPersonSites ?? 0) > 0) reasons.push('open-person-properties');
    if ((c.coverage.crashedFiles ?? 0) > 0) reasons.push('crashed-file');
    if (c.builtins.conditional.includes(name)) reasons.push('conditional-builtin');
    if (unknownTables.length > 0) reasons.push('unknown-builtin-table');
    if (hasPrefix(name, unknownNames.personProperties)) reasons.push('uncitable-name');
  }
  return reasons.length > 0
    ? { fact: 'unknown', unknown: unknown(reasons) }
    : { fact: 'no', unknown: [] };
}
