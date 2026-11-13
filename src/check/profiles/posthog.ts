// The `posthog` rules profile (spec 6.6, PostHog column). Value comparison follows V3 as far as it
// is settled: until T9.6 reproduces it in the demo, only exact, same-type mismatches count, and a
// case-only difference stays unknown (research/posthog-semantics.md, ADR-037).
import type { JsonScalar } from '../../formats/catalog.js';
import {
  NEGATIVE_OPERATORS,
  POSITIVE_OPERATORS,
  SEMVER_NEQ,
  checksScope,
  contains,
  equalStrings,
  valueRule,
} from './common.js';
import type { NeverSentEffect, RulesProfile, Tri } from './types.js';

function neverSent(op: string): NeverSentEffect {
  if (POSITIVE_OPERATORS.has(op) || op === SEMVER_NEQ) return 'no-match';
  if (NEGATIVE_OPERATORS.has(op)) return 'no-effect';
  return 'unknown';
}

// Compared as JSON values of the same type. Across types PostHog coerces (a filter "true" matches a
// boolean true, a number filter is stringified), and how far is open until V3's R1 to R3, so a
// type mismatch is unknown; so is null, which PostHog reads as a missing property.
function equal(filter: JsonScalar, code: JsonScalar): Tri {
  if (filter === null || code === null || typeof filter !== typeof code) return 'unknown';
  if (typeof filter === 'string') return equalStrings(filter, code as string);
  return filter === code ? 'yes' : 'no';
}

export const posthogProfile: RulesProfile = {
  name: 'posthog',
  neverSent,
  valueRule,
  equal,
  contains,
  checksScope,
  personNeedsObserved: true,
};
