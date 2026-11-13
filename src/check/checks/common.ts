// Helpers the checks share.
import type { Location, ObservedFact } from '../../formats/report.js';
import type { Tri } from '../profiles/types.js';
import type { CheckContext } from './types.js';

/** The finding's `observed` field; absent when the requirements have no observed data. */
export function observedField(ctx: CheckContext, fact: Tri): { observed?: ObservedFact } {
  if (ctx.facts.observed === undefined) return {};
  return { observed: fact === 'yes' ? 'seen' : fact === 'no' ? 'notSeen' : 'unknown' };
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The call sites of several events, in the order given, without repeats. */
export function sitesOf(ctx: CheckContext, events: Iterable<string>): Location[] {
  const out: Location[] = [];
  const seen = new Set<string>();
  for (const event of events)
    for (const site of ctx.index.sites(event)) {
      const key = `${site.file}:${site.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: site.file, line: site.line });
    }
  return out;
}
