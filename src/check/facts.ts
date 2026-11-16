// Three-valued facts (spec 6.7.1, T2): what the code says, what PostHog observed, and the one result
// the checks use. Only a definite "no" gives dead (T1); a source below 70% name resolution never
// gives an event-level dead from code alone (D9). The code facts come from the merged catalogs
// (extract's `eventFact`, `propertyFact`, `personPropertyFact`); `check` depends on `formats`
// only (spec 6.1), so the caller passes them in (ADR-037).
import { MIN_NAME_RESOLUTION_RATE, NO_CALL_SITE, type PropertyFact } from '../formats/catalog.js';
import { observedEvent } from '../formats/observed.js';
import type {
  Observed,
  ObservedEvent,
  Requirements,
  SeenProperties,
} from '../formats/requirements.js';
import type { RulesProfile, Tri } from './profiles/types.js';

/** A code fact as the catalog merge gives it. */
export interface CodeFact {
  fact: Tri;
  /** Why the fact is unknown; empty otherwise. */
  unknown: readonly string[];
}

export interface PropertyCodeFact extends CodeFact {
  /** Presence and values when the fact is "yes". */
  property?: PropertyFact;
  /** "yes" only: why `property.values` may not be every value the code sends. */
  incomplete?: readonly string[];
}

/** The code column of the 6.7.1 table, from the merged catalogs. */
export interface CodeFacts {
  event(name: string): CodeFact;
  property(event: string, key: string): PropertyCodeFact;
  personProperty(key: string): CodeFact;
  /** Each source's `coverage.nameResolutionRate`. */
  nameResolutionRates: readonly number[];
  /** Every source's `source.uncalledSdks` (ADR-069). */
  uncalledSdks?: readonly string[];
}

export interface FactInputs {
  code: CodeFacts;
  /** Absent: code only. */
  observed?: Observed;
  /** `source.pulledAt`: the end of the observed window. */
  pulledAt?: string;
  /**
   * The head of a diff only: the base's code. PostHog saw an event or property this code sends and
   * the head's does not (or only might) because of the code the change removes, so on the head that
   * sighting is unknown instead of "produced elsewhere" or a reason for live (ADR-060).
   */
  removedBy?: CodeFacts;
}

/** A sighting the removed code explains says nothing about the head (ADR-060). */
function explained(code: Tri, base: () => CodeFact | undefined): boolean {
  return code !== 'yes' && base()?.fact === 'yes';
}

export function factInputs(requirements: Requirements, code: CodeFacts): FactInputs {
  return {
    code,
    ...(requirements.observed === undefined ? {} : { observed: requirements.observed }),
    ...(requirements.source.pulledAt === undefined
      ? {}
      : { pulledAt: requirements.source.pulledAt }),
  };
}

export type EventStatus = 'live' | 'dead' | 'not-checked';

/**
 * Why a "no" holds: code and PostHog both say no (`high`), code alone (`code-only`), or PostHog
 * alone (`not-defined` for an event PostHog has no definition of, `observed` for a property an
 * arriving event never carried).
 */
export type NoBasis = 'high' | 'code-only' | 'not-defined' | 'observed';

export interface EventFacts {
  code: Tri;
  observed: Tri;
  status: EventStatus;
  /** Dead only. */
  basis?: NoBasis;
  /** Live although no code sends it: produced by a server, a CDP, autocapture or another repo. */
  producedElsewhere?: true;
  /** D6: sent in code, not seen in the window; a report section, not a verdict. */
  notArriving?: { enforcement?: 'reject' };
  /** Not checked only: the reasons, sorted. */
  reasons?: string[];
  /** Not checked for D9: the lowest name-resolution rate below 70%. */
  nameResolutionRate?: number;
}

export interface PropertyFacts {
  code: Tri;
  observed: Tri;
  /** Whether the event (or the person) carries the property. */
  sent: Tri;
  /** `sent` "no" only. */
  basis?: NoBasis;
  producedElsewhere?: true;
  /** Set in code, never seen by PostHog. */
  notArriving?: true;
  /** `sent` "unknown" only: the reasons, sorted. */
  reasons?: string[];
  /** From code, when it sends the property. */
  property?: PropertyFact;
  /** With `property`: why its values may be incomplete, sorted. */
  incomplete?: string[];
}

export const LOW_NAME_RESOLUTION = 'low-name-resolution';

/** The reason a PostHog person property stays unknown when its observed list was not read. */
export const PERSON_NOT_OBSERVED = 'person-properties-not-observed';

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function lowestLowRate(rates: readonly number[]): number | undefined {
  const low = rates.filter((r) => !(r >= MIN_NAME_RESOLUTION_RATE));
  return low.length > 0 ? Math.min(...low) : undefined;
}

// D9 and ADR-069 are applied by the merge; they are applied again here so no provider of code facts
// can turn a low-resolution source, or one with a declared SDK and no call of it, into an
// event-level "no".
function codeEvent(code: CodeFacts, name: string): { fact: CodeFact; rate?: number } {
  const uncalled = code.uncalledSdks ?? [];
  const given = code.event(name);
  const fact: CodeFact =
    given.fact === 'no' && uncalled.length > 0
      ? { fact: 'unknown', unknown: sorted(uncalled.map((p) => `${NO_CALL_SITE}${p}`)) }
      : given;
  const rate = lowestLowRate(code.nameResolutionRates);
  if (rate === undefined) return { fact };
  if (fact.fact === 'no')
    return { fact: { fact: 'unknown', unknown: sorted([LOW_NAME_RESOLUTION]) }, rate };
  return { fact, ...(fact.unknown.includes(LOW_NAME_RESOLUTION) ? { rate } : {}) };
}

function notChecked(
  code: Tri,
  observed: Tri,
  reasons: readonly string[],
  rate?: number,
): EventFacts {
  return {
    code,
    observed,
    status: 'not-checked',
    reasons: sorted(reasons),
    ...(rate === undefined ? {} : { nameResolutionRate: rate }),
  };
}

function observedEntry(observed: Observed | undefined, name: string): ObservedEvent | undefined {
  return observed !== undefined && Object.hasOwn(observed.events, name)
    ? observed.events[name]
    : undefined;
}

/** The 6.7.1 table for an event. */
export function eventFacts(inputs: FactInputs, name: string): EventFacts {
  const { fact, rate } = codeEvent(inputs.code, name);
  const code = fact.fact;
  const observed = explained(code, () => inputs.removedBy?.event(name))
    ? 'unknown'
    : observedEvent(inputs.observed, name, inputs.pulledAt ?? '');
  const entry = observedEntry(inputs.observed, name);
  if (code === 'no') {
    if (observed === 'yes') return { code, observed, status: 'live', producedElsewhere: true };
    return { code, observed, status: 'dead', basis: observed === 'no' ? 'high' : 'code-only' };
  }
  if (code === 'yes') {
    if (observed !== 'no') return { code, observed, status: 'live' };
    const enforcement = entry?.enforcement;
    return {
      code,
      observed,
      status: 'live',
      notArriving: enforcement === 'reject' ? { enforcement } : {},
    };
  }
  if (observed === 'yes') return { code, observed, status: 'live' };
  if (observed === 'no' && entry?.defined === false)
    return { code, observed, status: 'dead', basis: 'not-defined' };
  return notChecked(code, observed, fact.unknown, rate);
}

function seenFact(list: SeenProperties | undefined, key: string): Tri {
  if (list === undefined) return 'unknown';
  if (list.seen.includes(key)) return 'yes';
  return list.notSeen.includes(key) ? 'no' : 'unknown';
}

function eventProperties(
  observed: Observed | undefined,
  event: string,
): SeenProperties | undefined {
  const all = observed?.eventProperties;
  return all !== undefined && Object.hasOwn(all, event) ? all[event] : undefined;
}

function yes(code: Tri, observed: Tri, fact?: PropertyCodeFact): PropertyFacts {
  const incomplete = fact?.incomplete ?? [];
  return {
    code,
    observed,
    sent: 'yes',
    ...(code === 'no' ? { producedElsewhere: true as const } : {}),
    ...(code === 'yes' && observed === 'no' ? { notArriving: true as const } : {}),
    ...(fact?.property === undefined ? {} : { property: fact.property }),
    ...(fact?.property !== undefined && incomplete.length > 0
      ? { incomplete: sorted(incomplete) }
      : {}),
  };
}

function unknownSent(code: Tri, observed: Tri, reasons: readonly string[]): PropertyFacts {
  return { code, observed, sent: 'unknown', reasons: sorted(reasons) };
}

/**
 * The 6.7.1 table for an event property, with "ever seen on this event" as the observed fact; dead
 * from "unknown + not seen" only when the event itself is observed (it arrives without it).
 */
export function propertyFacts(inputs: FactInputs, event: string, key: string): PropertyFacts {
  const fact = inputs.code.property(event, key);
  const code = fact.fact;
  const observed = explained(code, () => inputs.removedBy?.property(event, key))
    ? 'unknown'
    : seenFact(eventProperties(inputs.observed, event), key);
  if (code === 'yes') return yes(code, observed, fact);
  if (observed === 'yes') return yes(code, observed);
  if (code === 'no')
    return { code, observed, sent: 'no', basis: observed === 'no' ? 'high' : 'code-only' };
  const arrives = observedEvent(inputs.observed, event, inputs.pulledAt ?? '') === 'yes';
  if (observed === 'no' && arrives) return { code, observed, sent: 'no', basis: 'observed' };
  return unknownSent(code, observed, fact.unknown);
}

/**
 * A person property (spec 6.6 row 8): "no" only when no catalog sets it and, in the `posthog`
 * profile, PostHog's person properties do not include it either. With no observed data at all the
 * code decides, as for events (code only).
 */
export function personPropertyFacts(
  inputs: FactInputs,
  key: string,
  profile: RulesProfile,
): PropertyFacts {
  const fact = inputs.code.personProperty(key);
  const code = fact.fact;
  const observed = seenFact(inputs.observed?.personProperties, key);
  if (code === 'yes' || observed === 'yes') return yes(code, observed);
  if (code === 'unknown') return unknownSent(code, observed, fact.unknown);
  if (observed === 'no') return { code, observed, sent: 'no', basis: 'high' };
  if (profile.personNeedsObserved && inputs.observed !== undefined)
    return unknownSent(code, observed, [PERSON_NOT_OBSERVED]);
  return { code, observed, sent: 'no', basis: 'code-only' };
}
