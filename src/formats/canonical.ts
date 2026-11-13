// Canonical writers (spec T2.3): JSON and YAML with a stable key order, so a file written twice from
// the same value is byte-identical and YAML -> JSON -> YAML (and JSON -> YAML -> JSON) round trips
// are byte-stable. Field keys follow the order of the schemas; map keys that are names (events in
// `observed.events`, `observed.eventProperties`) sort by code point; keys no schema lists come last,
// by code point.
import { stringify } from 'yaml';

// Order of field keys, roughly as the schemas list them. Only the relative order of keys that share
// an object matters.
const FIELD_ORDER = [
  'schema',
  'source',
  'platform',
  'host',
  'project',
  'pulledAt',
  'tool',
  'profile',
  'note',
  'id',
  'name',
  'title',
  'url',
  'dashboards',
  'kind',
  'dateRange',
  'from',
  'to',
  'testAccountFilter',
  'windowDays',
  'ref',
  'node',
  'event',
  'operator',
  'events',
  'eventProperties',
  'personProperties',
  'action',
  'steps',
  'table',
  'fromStep',
  'toStep',
  'math',
  'mathProperty',
  'key',
  'scope',
  'op',
  'values',
  'any',
  'series',
  'formulas',
  'index',
  'expression',
  'refs',
  'filters',
  'unsupported',
  'breakdown',
  'exclusions',
  'funnelVizType',
  'retention',
  'target',
  'returning',
  'notChecked',
  'path',
  'reason',
  'tile',
  'condition',
  'bounds',
  'lower',
  'upper',
  'interval',
  'enabled',
  'state',
  'defined',
  'lastSeenAt',
  'enforcement',
  'seen',
  'notSeen',
  'tiles',
  'alerts',
  'observed',
];

const RANK = new Map(FIELD_ORDER.map((k, i) => [k, i]));

// Objects under these keys are maps from a name to a value, not records with fields.
const NAME_MAPS = new Set(['events', 'eventProperties']);

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderedKeys(o: Record<string, unknown>, nameMap: boolean): string[] {
  const keys = Object.keys(o).filter((k) => o[k] !== undefined);
  if (nameMap) return keys.sort(byCodePoint);
  const last = FIELD_ORDER.length;
  return keys.sort((a, b) => (RANK.get(a) ?? last) - (RANK.get(b) ?? last) || byCodePoint(a, b));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// The value with every object turned into a Map in canonical order (a Map keeps the order of
// integer-like keys, which a plain object would move to the front). -0 is written as 0.
function ordered(v: unknown, nameMap = false): unknown {
  if (Array.isArray(v)) return v.map((item) => ordered(item));
  if (isObject(v))
    return new Map(orderedKeys(v, nameMap).map((k) => [k, ordered(v[k], NAME_MAPS.has(k))]));
  return Object.is(v, -0) ? 0 : v;
}

function json(v: unknown, indent: string): string {
  const inner = `${indent}  `;
  if (Array.isArray(v))
    return v.length === 0
      ? '[]'
      : `[\n${v.map((item) => inner + json(item, inner)).join(',\n')}\n${indent}]`;
  if (v instanceof Map) {
    if (v.size === 0) return '{}';
    const entries = [...v].map(([k, item]) => `${inner}${JSON.stringify(k)}: ${json(item, inner)}`);
    return `{\n${entries.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v);
}

/** Canonical JSON: two-space indent, stable key order, one trailing newline. */
export function toCanonicalJson(value: unknown): string {
  return `${json(ordered(value), '')}\n`;
}

/**
 * JSON for a value whose objects are already Maps in the order to write (the catalog writer orders
 * its own fields): two-space indent, one trailing newline.
 */
export function orderedJson(value: unknown): string {
  return `${json(value, '')}\n`;
}

/** Canonical YAML: block style, stable key order, no anchors, no line folding. */
export function toCanonicalYaml(value: unknown): string {
  return stringify(ordered(value), { lineWidth: 0, aliasDuplicateObjects: false, indent: 2 });
}
