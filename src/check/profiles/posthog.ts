// The `posthog` rules profile (spec 6.6, PostHog column). Value comparison follows V3 as far as it
// is settled (research/posthog-semantics.md, ADR-037, ADR-064): text compares case-sensitively,
// reproduced in the demo (R4); coercion across types stays unknown.
import type { JsonScalar } from '../../formats/catalog.js';
import {
  NEGATIVE_OPERATORS,
  POSITIVE_OPERATORS,
  SEMVER_NEQ,
  checksScope,
  contains,
  valueRule,
} from './common.js';
import type { NeverSentEffect, RulesProfile, Tri } from './types.js';

function neverSent(op: string): NeverSentEffect {
  if (POSITIVE_OPERATORS.has(op) || op === SEMVER_NEQ) return 'no-match';
  if (NEGATIVE_OPERATORS.has(op)) return 'no-effect';
  return 'unknown';
}

// Compared as JSON values of the same type. Across types PostHog coerces (a filter "true" matches a
// boolean true, a number filter is stringified), so a type mismatch is unknown; so is null, which
// PostHog reads as a missing property. Two texts that differ only in case never match (R4), except
// "true" and "false": against a Boolean-typed property PostHog converts the filter text, and how a
// sent "True" compares then was not reproduced (R3), so that stays unknown.
function equal(filter: JsonScalar, code: JsonScalar): Tri {
  if (filter === null || code === null || typeof filter !== typeof code) return 'unknown';
  if (typeof filter === 'string') {
    if (filter === code) return 'yes';
    const folded = filter.toLowerCase();
    if (folded === (code as string).toLowerCase() && (folded === 'true' || folded === 'false'))
      return 'unknown';
    return 'no';
  }
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
