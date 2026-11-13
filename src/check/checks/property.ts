// `property-is-sent` (spec 6.7.2) for filters and math properties: is the property sent on the event
// (event scope) or set for the person (person scope)? A never-sent property makes a positive filter
// or an event-scope math property dead and a negative filter degraded ("filter has no effect"), as
// the rules profile says (spec 6.6 rows 1 to 3). A sent filter property on a finite domain then goes
// to `value-is-reachable` (`value.ts`), whose effect becomes the filter's. Breakdowns are in
// `breakdown.ts`.
import type { Filter, PropertyFilter, PropertyRef, Scope } from '../../formats/requirements.js';
import { closestName } from '../closest.js';
import { personPropertyFacts, propertyFacts } from '../facts.js';
import { observedField, sitesOf, sortedUnique } from './common.js';
import type { CheckContext, PartEffect, PropertyCheck, PropertyRole } from './types.js';
import { checkValue } from './value.js';

/** Scopes outside the profile's (spec 6.6 row 7). */
export const SCOPE_NOT_CHECKED = 'scope-not-checked';
/** An event-scope property on every event: no one event's facts decide it. */
export const ALL_EVENTS = 'all-events';
/** An operator the profile does not list (ADR-037). */
export const OPERATOR_NOT_CHECKED = 'operator-not-checked';
/** A person-scope math property: spec 6.7.3 makes only an event-scope one dead (ADR-038). */
export const PERSON_MATH_PROPERTY = 'person-math-property';

interface PropertyPart {
  role: PropertyRole;
  key: string;
  scope: Scope;
  event: string | null;
  op?: string;
  values?: PropertyFilter['values'];
}

function unknownCheck(
  part: PropertyPart,
  reasons: readonly string[],
  extra: Partial<PropertyCheck> = {},
): PropertyCheck {
  return {
    ...base(part),
    sent: 'unknown',
    ...extra,
    effect: 'unknown',
    reasons: sortedUnique(reasons),
  };
}

function base(part: PropertyPart): Pick<PropertyCheck, 'role' | 'key' | 'scope' | 'event' | 'op'> {
  return {
    role: part.role,
    key: part.key,
    scope: part.scope,
    event: part.event,
    ...(part.op === undefined ? {} : { op: part.op }),
  };
}

/** The effect of a never-sent property on the part, by role. */
function noEffect(ctx: CheckContext, part: PropertyPart): PartEffect | string {
  if (part.role === 'breakdown') return 'degraded';
  if (part.role === 'math-property') return part.scope === 'event' ? 'dead' : PERSON_MATH_PROPERTY;
  const effect = ctx.profile.neverSent(part.op ?? '');
  if (effect === 'no-match') return 'dead';
  if (effect === 'no-effect') return 'degraded';
  return OPERATOR_NOT_CHECKED;
}

/** One property in one role on one event (or the person), with its finding. */
export function checkProperty(ctx: CheckContext, part: PropertyPart, path: string): PropertyCheck {
  if (!ctx.profile.checksScope(part.scope)) return unknownCheck(part, [SCOPE_NOT_CHECKED]);
  if (part.scope === 'event' && part.event === null) return unknownCheck(part, [ALL_EVENTS]);
  const event = part.event;
  const facts =
    part.scope === 'person'
      ? personPropertyFacts(ctx.facts, part.key, ctx.profile)
      : propertyFacts(ctx.facts, event as string, part.key);
  const found = { facts, ...(facts.property === undefined ? {} : { property: facts.property }) };
  if (facts.sent === 'unknown') return unknownCheck(part, facts.reasons ?? [], found);
  const common = {
    property: part.key,
    ...(event === null ? {} : { event }),
    ...(part.values === undefined ? {} : { values: [...part.values] }),
    code: facts.code,
    ...observedField(ctx, facts.observed),
  };
  const detail = {
    role: part.role,
    scope: part.scope,
    ...(part.op === undefined ? {} : { op: part.op }),
  };
  if (facts.sent === 'yes') {
    const presence = facts.property?.presence;
    const value =
      part.role === 'filter' && facts.property !== undefined
        ? checkValue(
            ctx,
            {
              event: event as string,
              key: part.key,
              scope: part.scope,
              op: part.op ?? '',
              values: part.values ?? [],
              property: facts.property,
              ...(facts.incomplete === undefined ? {} : { incomplete: facts.incomplete }),
              observed: facts.observed,
            },
            path,
          )
        : undefined;
    return {
      ...base(part),
      sent: 'yes',
      ...(presence === undefined ? {} : { presence }),
      ...found,
      ...(value === undefined ? {} : { value }),
      effect: value?.effect ?? 'live',
      ...(value?.effect === 'unknown' ? { reasons: value.reasons ?? [] } : {}),
      ...(facts.producedElsewhere === true
        ? {
            finding: {
              check: 'property-is-sent',
              path,
              effect: 'info',
              ...common,
              sites: [],
              detail: { ...detail, producedElsewhere: true },
            },
          }
        : {}),
    };
  }
  const effect = noEffect(ctx, part);
  if (effect !== 'dead' && effect !== 'degraded')
    return { ...unknownCheck(part, [effect], found), sent: 'no' };
  const candidates =
    part.scope === 'person'
      ? ctx.index.personPropertyKeys
      : ctx.index.propertyKeys(event as string);
  const closest = closestName(part.key, candidates);
  return {
    ...base(part),
    sent: 'no',
    ...found,
    effect,
    finding: {
      check: 'property-is-sent',
      path,
      effect,
      ...common,
      sites: part.scope === 'event' ? sitesOf(ctx, [event as string]) : [],
      ...(closest === undefined ? {} : { hint: { closestProperty: closest } }),
      detail: { ...detail, ...(facts.basis === undefined ? {} : { basis: facts.basis }) },
    },
  };
}

export interface FilterCheck {
  path: string;
  /** For an `any` filter, the OR of its members (ADR-038). */
  effect: PartEffect;
  /** One check, or one per member of an `any` filter. */
  checks: PropertyCheck[];
  /** Unknown only: the members' reasons, sorted. */
  reasons?: string[];
}

function filterPart(event: string | null, f: PropertyFilter): PropertyPart {
  return { role: 'filter', key: f.key, scope: f.scope, event, op: f.op, values: f.values };
}

// OR of members: a member that keeps every event keeps every event (degraded); the group drops
// everything only when every member does (dead); one live member makes it live; otherwise unknown.
function orEffect(effects: readonly PartEffect[]): PartEffect {
  if (effects.includes('degraded')) return 'degraded';
  if (effects.length > 0 && effects.every((e) => e === 'dead')) return 'dead';
  if (effects.includes('live')) return 'live';
  return 'unknown';
}

/**
 * A filter of a part on `event` (null: every event). A member's dead or degraded finding inside an
 * `any` filter that is not itself dead or degraded becomes an info finding.
 */
export function checkFilter(
  ctx: CheckContext,
  event: string | null,
  filter: Filter,
  path: string,
): FilterCheck {
  if (!('any' in filter)) {
    const check = checkProperty(ctx, filterPart(event, filter), path);
    return {
      path,
      effect: check.effect,
      checks: [check],
      ...(check.reasons === undefined ? {} : { reasons: check.reasons }),
    };
  }
  const checks = filter.any.map((f, i) =>
    checkProperty(ctx, filterPart(event, f), `${path}.any[${i}]`),
  );
  const effect = orEffect(checks.map((c) => c.effect));
  for (const c of checks) {
    if (c.finding !== undefined && c.finding.effect !== 'info' && c.finding.effect !== effect)
      c.finding = { ...c.finding, effect: 'info' };
    const v = c.value;
    if (v?.finding !== undefined && v.finding.effect !== effect)
      c.value = { ...v, finding: { ...v.finding, effect: 'info' } };
  }
  return {
    path,
    effect,
    checks,
    ...(effect === 'unknown'
      ? { reasons: sortedUnique(checks.flatMap((c) => c.reasons ?? [])) }
      : {}),
  };
}

/** A math property of a part on `event` (null: every event). */
export function checkMathProperty(
  ctx: CheckContext,
  event: string | null,
  ref: PropertyRef,
  path: string,
): PropertyCheck {
  return checkProperty(ctx, { role: 'math-property', key: ref.key, scope: ref.scope, event }, path);
}
