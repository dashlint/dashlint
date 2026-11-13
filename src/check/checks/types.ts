// What the checks of spec 6.7.2 take and give. A check result is the part's effect plus the facts
// behind it; a finding is the report's `Finding` without its message, which the report writes from
// these fields (T7.1, ADR-038).
import type { JsonScalar, Presence, PropertyFact } from '../../formats/catalog.js';
import type {
  CheckId,
  FindingEffect,
  FindingHint,
  Location,
  ObservedFact,
} from '../../formats/report.js';
import type { Scope } from '../../formats/requirements.js';
import type { EventFacts, FactInputs, NoBasis, PropertyFacts } from '../facts.js';
import type { RulesProfile, Tri } from '../profiles/types.js';

/** Names and locations from the merged catalogs, for hints and sites. */
export interface CodeIndex {
  /** Every event a catalog sends (by a call site or as a sent builtin). */
  events: readonly string[];
  /** The keys the code sends on an event (code "yes"). */
  propertyKeys(event: string): readonly string[];
  /** The person properties the code sets. */
  personPropertyKeys: readonly string[];
  /** The event's call sites, by source, then file and line; empty for a builtin-only event. */
  sites(event: string): readonly Location[];
}

export interface CheckContext {
  facts: FactInputs;
  index: CodeIndex;
  profile: RulesProfile;
}

/** What a check makes of one part: the verdict algebra (T6.4) reads it. */
export type PartEffect = 'live' | 'dead' | 'degraded' | 'unknown';

/** The role a property plays in a part (spec 6.7.2 `property-is-sent`). */
export type PropertyRole = 'filter' | 'math-property' | 'breakdown';

/** A report finding without its message. */
export interface CheckFinding {
  check: CheckId;
  path: string;
  effect: FindingEffect;
  event?: string;
  property?: string;
  values?: JsonScalar[];
  code: Tri;
  observed?: ObservedFact;
  sites: Location[];
  hint?: FindingHint;
  /** For the message: why the finding holds. */
  detail: FindingDetail;
}

export interface FindingDetail {
  /** Dead or "no" findings: what the "no" rests on. */
  basis?: NoBasis;
  /** Info findings: PostHog saw what no code sends. */
  producedElsewhere?: true;
  role?: PropertyRole;
  scope?: Scope;
  op?: string;
  /** Breakdowns: the events of the part that never send the key. */
  missingOn?: string[];
  /** Breakdowns and filters: the property is sent on some events only. */
  presence?: Presence;
}

export interface EventCheck {
  event: string;
  effect: PartEffect;
  facts: EventFacts;
  /** Unknown only: the reasons, sorted. */
  reasons?: string[];
  finding?: CheckFinding;
}

export interface PropertyCheck {
  role: PropertyRole;
  key: string;
  scope: Scope;
  /** null: every event (an all-events node or an action step with no event). */
  event: string | null;
  op?: string;
  /** Whether the event (or the person) carries the property. */
  sent: Tri;
  /** `sent` "yes" from code: always or sometimes. */
  presence?: Presence;
  /** From code, when it sends the property: T6.3 reads the values. */
  property?: PropertyFact;
  effect: PartEffect;
  facts?: PropertyFacts;
  /** Unknown only: the reasons, sorted. */
  reasons?: string[];
  finding?: CheckFinding;
}
