// `value-is-reachable` (spec 6.7.2): for `exact`, `is_not` and `icontains` on a finite domain, can
// the code send the filter's values? Values are compared by the rules profile (spec 6.6 rows 4 and
// 5): until spike V3 is reproduced in the demo (T9.6) only same-type mismatches count, so `"true"`
// against `[true, false]` is unknown, never dead. An `exact` or `icontains` filter none of whose
// values the code sends is dead; one with some unreachable values, or an `is_not` filter with any
// (it excludes nothing for them), is degraded (ADR-039).
import type { JsonScalar, PropertyFact } from '../../formats/catalog.js';
import type { Scope } from '../../formats/requirements.js';
import type { Tri, ValueRule } from '../profiles/types.js';
import { observedField, sitesOf, sortedUnique } from './common.js';
import type { CheckContext, ValueCheck } from './types.js';

/** The profile cannot compare a filter value with a code value (type, null or case, until V3). */
export const VALUE_NOT_COMPARABLE = 'value-not-comparable';
/** Spec 6.6 row 6: `regex` and `not_regex` values are not checked. */
export const REGEX_VALUES = 'regex-values';
/** A filter with no values: what it matches is the platform's rule, not the code's. */
export const NO_VALUES = 'no-values';
/** `icontains` with several values: how they combine is not settled (ADR-039). */
export const SEVERAL_CONTAINS_VALUES = 'several-icontains-values';

const REGEX_OPERATORS: ReadonlySet<string> = new Set(['regex', 'not_regex']);

export interface ValueInput {
  event: string;
  key: string;
  scope: Scope;
  op: string;
  values: readonly JsonScalar[];
  /** What the code sends; only a finite domain is checked. */
  property: PropertyFact;
  /** Why the domain may be incomplete (from the merge); a "no" is then unknown. */
  incomplete?: readonly string[];
  /** The property's observed fact, for the finding. */
  observed: Tri;
}

function unknownValue(input: ValueInput, reasons: readonly string[]): ValueCheck {
  return {
    op: input.op,
    values: [...input.values],
    effect: 'unknown',
    unreachable: [],
    reasons: sortedUnique(reasons),
  };
}

/** Whether the code sends one filter value: "yes" when any code value matches. */
function reach(
  ctx: CheckContext,
  rule: Exclude<ValueRule, 'not-checked'>,
  value: JsonScalar,
  set: readonly JsonScalar[],
): Tri {
  let undecided = false;
  for (const code of set) {
    const r = rule === 'equal' ? ctx.profile.equal(value, code) : ctx.profile.contains(value, code);
    if (r === 'yes') return 'yes';
    if (r === 'unknown') undecided = true;
  }
  return undecided ? 'unknown' : 'no';
}

/**
 * One filter on a property the code sends. `undefined` when the check does not apply: an open
 * domain, or an operator other than `exact`, `is_not`, `icontains`, `regex` and `not_regex`.
 */
export function checkValue(
  ctx: CheckContext,
  input: ValueInput,
  path: string,
): ValueCheck | undefined {
  const domain = input.property.values;
  if (domain.kind !== 'finite') return undefined;
  const rule = ctx.profile.valueRule(input.op);
  if (rule === 'not-checked')
    return REGEX_OPERATORS.has(input.op) ? unknownValue(input, [REGEX_VALUES]) : undefined;
  if (input.values.length === 0) return unknownValue(input, [NO_VALUES]);
  if (rule === 'contains' && input.values.length > 1)
    return unknownValue(input, [SEVERAL_CONTAINS_VALUES]);

  const incomplete = input.incomplete ?? [];
  const reasons: string[] = [];
  const unreachable: JsonScalar[] = [];
  let reachable = 0;
  for (const value of input.values) {
    const r = reach(ctx, rule, value, domain.set);
    if (r === 'yes') reachable++;
    else if (r === 'unknown') reasons.push(VALUE_NOT_COMPARABLE);
    else if (incomplete.length > 0) reasons.push(...incomplete);
    else unreachable.push(value);
  }
  if (unreachable.length === 0)
    return reasons.length === 0
      ? { op: input.op, values: [...input.values], effect: 'live', unreachable }
      : unknownValue(input, reasons);

  // An `is_not` value the code never sends excludes nothing; an `exact` or `icontains` filter
  // matches nothing only when no value is reachable or undecided.
  const effect =
    input.op === 'is_not'
      ? 'degraded'
      : reachable === 0 && reasons.length === 0
        ? 'dead'
        : 'degraded';
  return {
    op: input.op,
    values: [...input.values],
    effect,
    unreachable,
    ...(reasons.length === 0 ? {} : { reasons: sortedUnique(reasons) }),
    finding: {
      check: 'value-is-reachable',
      path,
      effect,
      event: input.event,
      property: input.key,
      values: [...input.values],
      code: 'yes',
      ...observedField(ctx, input.observed),
      sites: sitesOf(ctx, [input.event]),
      hint: { reachableValues: [...domain.set] },
      detail: { role: 'filter', scope: input.scope, op: input.op, unreachable },
    },
  };
}
