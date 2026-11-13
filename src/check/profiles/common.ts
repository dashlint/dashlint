// The parts of spec 6.6 both profiles share. Operators are listed exactly as the table lists them;
// any other operator is unknown (G15, ADR-037).
import type { JsonScalar } from '../../formats/catalog.js';
import type { Scope } from '../../formats/requirements.js';
import type { Tri, ValueRule } from './types.js';

/** Row 1: positive operators; on a never-sent property they match nothing. */
export const POSITIVE_OPERATORS: ReadonlySet<string> = new Set([
  'exact',
  'icontains',
  'regex',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_set',
  'is_date_exact',
  'is_date_before',
  'is_date_after',
  'semver_eq',
  'semver_gt',
  'semver_gte',
  'semver_lt',
  'semver_lte',
  'semver_tilde',
  'semver_caret',
  'semver_wildcard',
]);

/** Row 2: negative operators; in PostHog they keep events that lack the property [F9]. */
export const NEGATIVE_OPERATORS: ReadonlySet<string> = new Set([
  'is_not',
  'not_icontains',
  'not_regex',
  'is_not_set',
  'not_in',
]);

/** Row 3: unlike the negative operators, PostHog's `semver_neq` drops events lacking the property. */
export const SEMVER_NEQ = 'semver_neq';

const VALUE_RULES: Readonly<Record<string, ValueRule>> = {
  exact: 'equal',
  is_not: 'equal',
  icontains: 'contains',
};

/** Rows 4 to 6: `regex`, `not_regex` and every other operator are not checked. */
export function valueRule(op: string): ValueRule {
  return Object.hasOwn(VALUE_RULES, op) ? (VALUE_RULES[op] as ValueRule) : 'not-checked';
}

/** Row 7. */
export function checksScope(scope: Scope): boolean {
  return scope === 'event' || scope === 'person';
}

/**
 * Two strings: equal, different, or unknown when they differ only in case. Whether the platform
 * compares case-sensitively is open until spike V3 is reproduced in the demo (R4, T9.6).
 */
export function equalStrings(filter: string, code: string): Tri {
  if (filter === code) return 'yes';
  return filter.toLowerCase() === code.toLowerCase() ? 'unknown' : 'no';
}

// Only ASCII text folds case the same way everywhere; other text is decided only when it matches
// as written.
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

/** Row 5: `icontains` is a case-insensitive substring test over string values. */
export function contains(filter: JsonScalar, code: JsonScalar): Tri {
  if (typeof filter !== 'string' || typeof code !== 'string') return 'unknown';
  if (code.includes(filter)) return 'yes';
  if (!isAscii(filter) || !isAscii(code)) return 'unknown';
  return code.toLowerCase().includes(filter.toLowerCase()) ? 'yes' : 'no';
}
