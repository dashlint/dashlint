// `alert-can-never-fire` (spec 6.7.2, 6.7.4): what an alert does when the part it watches is always
// zero. PostHog compares the value (absolute_value) or its change from the interval before
// (relative_*), which on a constant zero is 0, with the lower bound first, then the upper
// (`products/alerts/backend/evaluation/comparator.py`). Threshold numbers are never stored, so a
// lower bound is taken to be above zero and an upper bound not below it (ADR-041).
import type { Alert } from '../../formats/requirements.js';

/** Decided by an anomaly detector, not by bounds: unknown on a dead part (spec 6.7.4). */
export const ALERT_CONDITION_DETECTOR = 'alert-condition-detector';
/** A condition dashlint does not know. */
export const ALERT_CONDITION_UNKNOWN = 'alert-condition-unknown';

const THRESHOLD_CONDITIONS: ReadonlySet<string> = new Set([
  'absolute_value',
  'relative_increase',
  'relative_decrease',
]);

export const isRelative = (condition: string): boolean =>
  condition === 'relative_increase' || condition === 'relative_decrease';

export type FireOnZero =
  { result: 'can-never-fire' | 'fires-every-check' } | { result: 'unknown'; reason: string };

/**
 * The alert on a part that is always zero: a lower bound breaches on every check (noise), an
 * upper bound or none never does.
 */
export function fireOnZero(alert: Pick<Alert, 'condition' | 'bounds'>): FireOnZero {
  if (alert.condition === 'detector')
    return { result: 'unknown', reason: ALERT_CONDITION_DETECTOR };
  if (!THRESHOLD_CONDITIONS.has(alert.condition))
    return { result: 'unknown', reason: ALERT_CONDITION_UNKNOWN };
  return { result: alert.bounds.lower ? 'fires-every-check' : 'can-never-fire' };
}
