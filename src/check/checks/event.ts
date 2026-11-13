// `event-has-call-site` (spec 6.7.2): does any merged catalog, or a sent builtin, send the event?
// The 6.7.1 table decides; this check turns its result into the part's effect and a finding.
import { closestName } from '../closest.js';
import { eventFacts } from '../facts.js';
import { observedField, sitesOf } from './common.js';
import type { CheckContext, EventCheck } from './types.js';

/**
 * Dead only from a definite "no" (T1): no code sends the event, or PostHog has no definition of it.
 * A dead finding names the closest event the code sends, with that event's call sites. An event
 * PostHog sees but no code sends is live with an info finding.
 */
export function checkEvent(ctx: CheckContext, event: string, path: string): EventCheck {
  const facts = eventFacts(ctx.facts, event);
  if (facts.status === 'not-checked')
    return { event, effect: 'unknown', facts, reasons: [...(facts.reasons ?? [])] };
  if (facts.status === 'live') {
    if (facts.producedElsewhere !== true) return { event, effect: 'live', facts };
    return {
      event,
      effect: 'live',
      facts,
      finding: {
        check: 'event-has-call-site',
        path,
        effect: 'info',
        event,
        code: facts.code,
        ...observedField(ctx, facts.observed),
        sites: [],
        detail: { producedElsewhere: true },
      },
    };
  }
  const closest = closestName(event, ctx.index.events);
  return {
    event,
    effect: 'dead',
    facts,
    finding: {
      check: 'event-has-call-site',
      path,
      effect: 'dead',
      event,
      code: facts.code,
      ...observedField(ctx, facts.observed),
      sites: closest === undefined ? [] : sitesOf(ctx, [closest]),
      ...(closest === undefined ? {} : { hint: { closestEvent: closest } }),
      detail: { ...(facts.basis === undefined ? {} : { basis: facts.basis }) },
    },
  };
}
