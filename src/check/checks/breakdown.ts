// `property-is-sent` for a breakdown key (spec 6.7.2, 6.7.3): a key never sent on any event of the
// tile's live parts puts every row in one "(none)" bucket (degraded); a key sent on some of them,
// or only sometimes, is live with an info line. The caller (T6.4) passes the live parts' events.
import type { PropertyRef, Scope } from '../../formats/requirements.js';
import { closestName } from '../closest.js';
import { sitesOf, sortedUnique } from './common.js';
import { checkProperty } from './property.js';
import type { CheckContext, CheckFinding, PartEffect, PropertyCheck } from './types.js';

/** A breakdown with no live event to check it on. */
export const NO_LIVE_EVENT = 'no-live-event';

export interface BreakdownCheck {
  key: string;
  scope: Scope;
  path: string;
  effect: PartEffect;
  /** One per event (one for a person-scope key). */
  checks: PropertyCheck[];
  /** Unknown only: the reasons, sorted. */
  reasons?: string[];
  finding?: CheckFinding;
}

export function checkBreakdown(
  ctx: CheckContext,
  ref: PropertyRef,
  events: readonly (string | null)[],
  path: string,
): BreakdownCheck {
  const head = { key: ref.key, scope: ref.scope, path };
  const part = (event: string | null) =>
    checkProperty(ctx, { role: 'breakdown', key: ref.key, scope: ref.scope, event }, path);
  // A person property is the same on every event: one check decides.
  const checks =
    ref.scope === 'person' ? [part(null)] : [...new Set(events)].map((event) => part(event));
  if (checks.length === 0) return { ...head, effect: 'unknown', checks, reasons: [NO_LIVE_EVENT] };
  const sending = checks.filter((c) => c.sent === 'yes');
  const missing = checks.filter((c) => c.sent === 'no' && c.effect === 'degraded');
  if (sending.length === 0) {
    if (missing.length < checks.length) {
      const reasons = sortedUnique(checks.flatMap((c) => c.reasons ?? []));
      return { ...head, effect: 'unknown', checks, reasons };
    }
    const only = missing.length === 1 ? missing[0] : undefined;
    return {
      ...head,
      effect: 'degraded',
      checks,
      finding: only?.finding ?? merged(ctx, ref, missing),
    };
  }
  const sometimes = sending.some((c) => c.presence === 'sometimes');
  if (missing.length === 0 && !sometimes) return { ...head, effect: 'live', checks };
  return {
    ...head,
    effect: 'live',
    checks,
    finding: info(ctx, ref, path, checks, missing, sometimes),
  };
}

function eventsOf(checks: readonly PropertyCheck[]): string[] {
  return checks.flatMap((c) => (c.event === null ? [] : [c.event]));
}

// Several events, none sends the key: one finding naming them all.
function merged(
  ctx: CheckContext,
  ref: PropertyRef,
  missing: readonly PropertyCheck[],
): CheckFinding {
  const first = missing[0]?.finding as CheckFinding;
  const events = eventsOf(missing);
  const closest = closestName(
    ref.key,
    events.flatMap((e) => ctx.index.propertyKeys(e)),
  );
  return {
    check: first.check,
    path: first.path,
    effect: first.effect,
    property: ref.key,
    code: first.code,
    ...(first.observed === undefined ? {} : { observed: first.observed }),
    sites: sitesOf(ctx, events),
    ...(closest === undefined ? {} : { hint: { closestProperty: closest } }),
    detail: { ...first.detail, missingOn: events },
  };
}

function info(
  ctx: CheckContext,
  ref: PropertyRef,
  path: string,
  checks: readonly PropertyCheck[],
  missing: readonly PropertyCheck[],
  sometimes: boolean,
): CheckFinding {
  const events = eventsOf(missing);
  const sending = checks.filter((c) => c.sent === 'yes');
  const single = sending.length === 1 && missing.length === 0 ? sending[0] : undefined;
  return {
    check: 'property-is-sent',
    path,
    effect: 'info',
    ...(single?.event === undefined || single.event === null ? {} : { event: single.event }),
    property: ref.key,
    code: 'yes',
    sites: sitesOf(ctx, events),
    detail: {
      role: 'breakdown',
      scope: ref.scope,
      ...(events.length === 0 ? {} : { missingOn: events }),
      ...(sometimes ? { presence: 'sometimes' as const } : {}),
    },
  };
}
