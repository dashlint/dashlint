// What a rules profile decides (spec 6.6): platform semantics the checks must not guess.
import type { JsonScalar } from '../../formats/catalog.js';
import type { Scope } from '../../formats/requirements.js';

export type Tri = 'yes' | 'no' | 'unknown';

export type ProfileName = 'posthog' | 'generic';

/**
 * What a filter does to an event that never carries the filter's property: `no-match` drops the
 * event (the part is dead), `no-effect` keeps every event (the filter does nothing: degraded),
 * `unknown` when the platform's semantics are not known for the operator.
 */
export type NeverSentEffect = 'no-match' | 'no-effect' | 'unknown';

/** How a filter value is compared with the values the code sends. */
export type ValueRule = 'equal' | 'contains' | 'not-checked';

export interface RulesProfile {
  name: ProfileName;
  /** Spec 6.6 rows 1 to 3. */
  neverSent(op: string): NeverSentEffect;
  /** Spec 6.6 rows 4 to 6: `exact` and `is_not` compare by `equal`, `icontains` by `contains`. */
  valueRule(op: string): ValueRule;
  /** Whether a filter value equals a value the code sends (row 4). */
  equal(filter: JsonScalar, code: JsonScalar): Tri;
  /** Whether a value the code sends contains a filter value, ignoring case (row 5). */
  contains(filter: JsonScalar, code: JsonScalar): Tri;
  /** Row 7: scopes outside `event` and `person` are not checked. */
  checksScope(scope: Scope): boolean;
  /** Row 8: a person property is "no" only when observed person properties also lack it. */
  personNeedsObserved: boolean;
}
