// The `generic` rules profile (spec 6.6, generic column): for every platform but PostHog, only what
// holds on any platform is decided.
import type { JsonScalar } from '../../formats/catalog.js';
import { POSITIVE_OPERATORS, checksScope, contains, equalStrings, valueRule } from './common.js';
import type { NeverSentEffect, RulesProfile, Tri } from './types.js';

// A positive operator never matches a missing property; what negative operators and `semver_neq`
// do with one depends on the platform.
function neverSent(op: string): NeverSentEffect {
  return POSITIVE_OPERATORS.has(op) ? 'no-match' : 'unknown';
}

// Unknown unless both sides are strings.
function equal(filter: JsonScalar, code: JsonScalar): Tri {
  return typeof filter === 'string' && typeof code === 'string'
    ? equalStrings(filter, code)
    : 'unknown';
}

export const genericProfile: RulesProfile = {
  name: 'generic',
  neverSent,
  valueRule,
  equal,
  contains,
  checksScope,
  personNeedsObserved: false,
};
