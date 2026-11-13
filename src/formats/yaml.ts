// The hand-written requirements file (spec 6.6, T2.3): YAML (or JSON, which is YAML) with the
// shorthands expanded into the canonical form of schema/requirements.schema.json, then validated.
// Parsing is plain YAML 1.2 core: no custom or YAML 1.1 tags, no merge keys, no duplicate keys, one
// document. Every error names its line.
import {
  type Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  visit,
  type YAMLError,
} from 'yaml';
import { validation } from '../report/messages.js';
import type { Requirements } from './requirements.js';
import { type ValidationError, type ValidationResult, validateRequirements } from './validate.js';

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Series letter for a 0-based position: A to Z, then AA, AB, ... */
export function refLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// `scope` defaults to `event` on any property (filter, math property, breakdown object).
function withScope(p: Json): Json {
  return 'scope' in p ? p : { ...p, scope: 'event' };
}

function expandPropertyFilter(f: Json): Json {
  const out = withScope(f);
  return {
    ...out,
    ...('op' in out ? {} : { op: 'exact' }),
    ...('values' in out && !Array.isArray(out['values']) ? { values: [out['values']] } : {}),
  };
}

function expandFilter(f: unknown): unknown {
  if (!isObject(f)) return f;
  if ('any' in f) return Array.isArray(f['any']) ? { ...f, any: f['any'].map(expandFilter) } : f;
  return expandPropertyFilter(f);
}

function expandFilters(v: unknown): unknown {
  return Array.isArray(v) ? v.map(expandFilter) : v;
}

// Expands `filters` on an object that may carry them (node, group member, action step, dashboard).
function withFilters(o: Json): Json {
  return 'filters' in o ? { ...o, filters: expandFilters(o['filters']) } : o;
}

function expandNode(n: unknown, ref?: string): unknown {
  if (!isObject(n)) return n;
  let out: Json = withFilters(n);
  if (!('node' in out) && 'event' in out) out = { node: 'event', ...out };
  if (ref !== undefined && !('ref' in out)) out = { ref, ...out };
  if (isObject(out['mathProperty'])) out = { ...out, mathProperty: withScope(out['mathProperty']) };
  if (Array.isArray(out['events']))
    out = { ...out, events: out['events'].map((m) => (isObject(m) ? withFilters(m) : m)) };
  const action = out['action'];
  if (isObject(action) && Array.isArray(action['steps']))
    out = {
      ...out,
      action: {
        ...action,
        steps: action['steps'].map((s) => (isObject(s) ? withFilters(s) : s)),
      },
    };
  return out;
}

function expandBreakdown(b: unknown): unknown {
  if (typeof b === 'string') return { key: b, scope: 'event' };
  return isObject(b) ? withScope(b) : b;
}

function expandTile(t: unknown): unknown {
  if (!isObject(t)) return t;
  let out = withFilters(t);
  if (Array.isArray(out['series']))
    out = { ...out, series: out['series'].map((s, i) => expandNode(s, refLetter(i))) };
  if (Array.isArray(out['exclusions']))
    out = { ...out, exclusions: out['exclusions'].map((x) => expandNode(x)) };
  if (Array.isArray(out['breakdown']))
    out = { ...out, breakdown: out['breakdown'].map(expandBreakdown) };
  const retention = out['retention'];
  if (isObject(retention))
    out = {
      ...out,
      retention: {
        ...retention,
        ...('target' in retention ? { target: expandNode(retention['target']) } : {}),
        ...('returning' in retention ? { returning: expandNode(retention['returning']) } : {}),
      },
    };
  return out;
}

/**
 * Expands the spec 6.6 shorthands into the canonical form; returns a new value and leaves anything
 * of an unexpected shape as it is, for the validator to report. Expanding the canonical form is a
 * no-op, so files written by `pull` go through the same path.
 */
export function expandRequirements(data: unknown): unknown {
  if (!isObject(data)) return data;
  let out = data;
  if (Array.isArray(out['dashboards']))
    out = {
      ...out,
      dashboards: out['dashboards'].map((d) => (isObject(d) ? withFilters(d) : d)),
    };
  if (Array.isArray(out['tiles'])) out = { ...out, tiles: out['tiles'].map(expandTile) };
  return out;
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

// The line of the deepest part of `pointer` that exists in the source: the key of a map entry, or
// the item of a sequence. A field the expansion added (an assigned `ref`) points at its parent.
function lineOf(doc: Document, lc: LineCounter, pointer: string): number | undefined {
  let node: unknown = doc.contents;
  let offset = isNode(node) ? node.range?.[0] : undefined;
  for (const segment of pointer.split('/').slice(1).map(unescapePointer)) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === segment);
      if (!pair) break;
      if (isScalar(pair.key) && pair.key.range) offset = pair.key.range[0];
      node = pair.value;
    } else if (isSeq(node) && /^\d+$/.test(segment)) {
      const item: unknown = node.items[Number(segment)];
      if (!isNode(item)) break;
      if (item.range) offset = item.range[0];
      node = item;
    } else break;
  }
  return offset === undefined ? undefined : lc.linePos(offset).line;
}

// The key a DUPLICATE_KEY error points at (the error's own range covers one character).
function keyAt(doc: Document, offset: number): string | undefined {
  let key: string | undefined;
  visit(doc, {
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.range?.[0] === offset) {
        key = String(pair.key.value);
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return key;
}

function fromYamlError(
  e: YAMLError,
  doc: Document,
  source: string,
  lc: LineCounter,
): ValidationError {
  const message =
    e.code === 'TAG_RESOLVE_FAILED'
      ? validation.yamlTag(source.slice(e.pos[0], e.pos[1]))
      : e.code === 'DUPLICATE_KEY'
        ? validation.yamlDuplicateKey(keyAt(doc, e.pos[0]) ?? source.slice(e.pos[0], e.pos[1]))
        : validation.yamlSyntax(e.message);
  return { path: '', message, line: lc.linePos(e.pos[0]).line };
}

/**
 * Reads a requirements file (YAML, or JSON) from text: parse, expand the shorthands, validate.
 * Every error carries the line it points at.
 */
export function loadRequirements(source: string): ValidationResult<Requirements> {
  const lc = new LineCounter();
  const doc = parseDocument(source, {
    lineCounter: lc,
    prettyErrors: false,
    schema: 'core',
    resolveKnownTags: false,
    merge: false,
    uniqueKeys: true,
  });
  // An unresolved tag (`!!js/function`, `!foo`, a YAML 1.1 tag) is only a warning to the parser: it
  // still reads the value as a string. Here every warning refuses the file.
  const parseErrors = [...doc.errors, ...doc.warnings].map((e) =>
    fromYamlError(e, doc, source, lc),
  );
  visit(doc, {
    Scalar(_, s) {
      if (typeof s.value === 'number' && !Number.isFinite(s.value))
        parseErrors.push({
          path: '',
          message: validation.notFinite,
          line: lc.linePos(s.range?.[0] ?? 0).line,
        });
    },
  });
  if (parseErrors.length)
    return { ok: false, errors: parseErrors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0)) };
  const result = validateRequirements(expandRequirements(doc.toJS({ maxAliasCount: 100 })));
  if (result.ok) return result;
  return {
    ok: false,
    errors: result.errors.map((e) => {
      const line = lineOf(doc, lc, e.path);
      return line === undefined ? e : { ...e, line };
    }),
  };
}
