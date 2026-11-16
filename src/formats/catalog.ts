// `dashlint.catalog/1` (spec 6.3.1): what one source's code sends. The JSON Schema in
// schema/catalog.schema.json is the contract; these types mirror it.

export const CATALOG_SCHEMA = 'dashlint.catalog/1';

/** A JSON value a finite domain can hold. `true` and `"true"` are different values. */
export type JsonScalar = string | number | boolean | null;

export type OpenValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown';

/** At most 50 distinct values (finite), or open with a primitive type. */
export type ValueDomain =
  { kind: 'finite'; set: JsonScalar[] } | { kind: 'open'; type: OpenValueType };

/** A listed property is "yes"; "no" and "unknown" are derived, never written. */
export type Presence = 'always' | 'sometimes';

export type IdentityContext = 'module-init' | 'mount-effect' | 'handler' | 'other';

export type OpenWorldKind = 'event-name' | 'properties' | 'unresolved-import' | 'file-error';

export interface CatalogSdk {
  id: string;
  version: string | null;
  types: 'installed' | 'stub';
}

export interface CatalogSource {
  name: string;
  /** "." for the repository root, otherwise a relative path with `/` separators. */
  root: string;
  commit: string | null;
  platforms: string[];
  sdks: CatalogSdk[];
  /**
   * SDK packages the source's package.json declares (a loaded descriptor describes them) with no
   * call of them found: no event of the source is "no" from code alone (ADR-069). Sorted; absent
   * when empty.
   */
  uncalledSdks?: string[];
}

/**
 * The head of the reason a source gives when its package.json declares an SDK package and no call
 * of it was found (ADR-069); the package name follows.
 */
export const NO_CALL_SITE = 'no-call-site:';

/** D9: below this name-resolution rate a source gives no event-level "no" from code alone. */
export const MIN_NAME_RESOLUTION_RATE = 0.7;

export interface Coverage {
  files: number;
  excludedFiles: number;
  oversizeFiles?: number;
  crashedFiles?: number;
  callSites: number;
  literalNameSites: number;
  openSites: number;
  /** literalNameSites / callSites, rounded to three decimals. */
  nameResolutionRate: number;
  /** Super property calls whose argument is open: no event is certain to lack a property. */
  openSuperSites?: number;
  /** Person property calls whose argument is open. */
  openPersonSites?: number;
}

export interface OpenWorldSite {
  file: string;
  line: number;
  kind: OpenWorldKind;
  reason: string;
  /** An `event-name` site's fixed head: it can only send names that start with it (ADR-061). */
  prefix?: string;
  /** An `event-name` site's fixed tail: it can only send names that end with it (ADR-061). */
  suffix?: string;
}

export interface EventSite {
  file: string;
  line: number;
  sdk: string;
  via: string[];
  platforms: string[];
  openProperties: boolean;
}

export interface PropertyFact {
  presence: Presence;
  values: ValueDomain;
}

export interface CatalogEvent {
  sites: EventSite[];
  /** Sites of this event whose properties are open (`openProperties: true`). */
  openSites: number;
  properties: Record<string, PropertyFact>;
}

export interface CallSite {
  file: string;
  line: number;
  call: string;
}

export interface SuperProperty extends PropertyFact {
  sites: CallSite[];
}

export interface PersonProperty {
  sites: CallSite[];
}

export interface Builtins {
  events: string[];
  /** The builtins table that applies, such as `posthog-js@1`; null when none does. */
  properties: string | null;
  /** Builtins whose condition could not be evaluated: unknown, never "not sent". */
  conditional: string[];
  /** Builtins the init options turn off: not sent, although the table lists them. */
  off?: string[];
}

export interface IdentityCall {
  call: string;
  file: string;
  line: number;
  context: IdentityContext;
}

export interface Catalog {
  schema: typeof CATALOG_SCHEMA;
  tool: string;
  source: CatalogSource;
  coverage: Coverage;
  openWorld: OpenWorldSite[];
  events: Record<string, CatalogEvent>;
  superProperties: Record<string, SuperProperty>;
  personProperties: Record<string, PersonProperty>;
  builtins: Builtins;
  identity: IdentityCall[];
}
