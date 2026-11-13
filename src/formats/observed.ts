// Reading the observed data of a requirements file (spec 6.5.4): the adapter writes it, the checks
// read it, so the reader lives with the format both depend on.
import type { Observed, ObservedEvent } from './requirements.js';

/**
 * Whether PostHog saw an event inside the window ending at `at` (the pull time): yes when its
 * `lastSeenAt` is inside the last `windowDays` days, no when it is not defined or was last seen
 * earlier, unknown when `observed` is absent, the event was not read, or the time is not known.
 */
export function observedEvent(
  observed: Observed | undefined,
  event: string,
  at: string | Date,
): 'yes' | 'no' | 'unknown' {
  if (observed === undefined || !Object.hasOwn(observed.events, event)) return 'unknown';
  const fact = observed.events[event] as ObservedEvent;
  if (!fact.defined) return 'no';
  if (typeof fact.lastSeenAt !== 'string') return 'unknown';
  const seen = Date.parse(fact.lastSeenAt);
  const end = typeof at === 'string' ? Date.parse(at) : at.getTime();
  if (Number.isNaN(seen) || Number.isNaN(end)) return 'unknown';
  return seen >= end - observed.windowDays * 86_400_000 ? 'yes' : 'no';
}
