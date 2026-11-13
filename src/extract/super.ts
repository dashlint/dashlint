// Super and person properties (spec 6.4 item 7, T3.7). `register` (and descriptor equivalents)
// adds super properties, `sometimes`, to every event of the same source; identify's `$set`,
// `setPersonProperties` and `people.set` fill person properties. The argument is read as an event's
// properties are (T3.6), so an index signature or `any` there is open with the reason (G15): the
// properties it lists are still set, but "no" facts it could change stay unknown.
import ts from 'typescript';
import type { MemberCall } from '../descriptors/index.js';
import type { CallSite, OpenWorldSite, PersonProperty, SuperProperty } from '../formats/catalog.js';
import { readObjectAt, unionDomains, type ObjectRead } from './properties.js';
import type { SdkCall } from './sdk-calls.js';
import { valueAt } from './wrappers.js';

export interface SuperScan {
  /** Sorted by name; presence is always `sometimes` (spec 6.4 item 7). */
  superProperties: Record<string, SuperProperty>;
  /** Sorted by name. */
  personProperties: Record<string, PersonProperty>;
  /** Super property calls whose argument is open: no event of the source is certain to lack a property. */
  openSuperSites: number;
  /** Person property calls whose argument is open. */
  openPersonSites: number;
  /** One `properties` entry per open call, with the reason, in file order. */
  openWorld: OpenWorldSite[];
}

function byName<T>(map: Map<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    out[key] = map.get(key) as T;
  return out;
}

function compareSites(a: CallSite | OpenWorldSite, b: CallSite | OpenWorldSite): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;
}

/**
 * How a person property site is labelled: `identify.$set`, `setPersonProperties.$set_once`, or the
 * member alone when it sets one kind only (`people.set`).
 */
function personLabel(call: SdkCall, which: 'personSet' | 'personSetOnce'): string {
  const [container = '', member = ''] = call.declaration.split(/\.(?=[^.]*$)/);
  const nested = container.includes('.')
    ? `${container.slice(container.lastIndexOf('.') + 1)}.`
    : '';
  const both = call.entry.personSet !== undefined && call.entry.personSetOnce !== undefined;
  const suffix =
    both || call.entry.identity ? (which === 'personSet' ? '.$set' : '.$set_once') : '';
  return `${nested}${member}${suffix}`;
}

class SuperReader {
  constructor(private readonly checker: ts.TypeChecker) {}

  /**
   * Whether the value certainly has no `keys` (`identify(id, { email })` has no `$set_once`): its
   * type is closed, with no index signature, and lacks the key. Then nothing is set from there.
   */
  private lacksKey(node: ts.Expression, keys: readonly string[]): boolean {
    let type = this.checker.getTypeAtLocation(node);
    for (const key of keys) {
      type = this.checker.getNonNullableType(type);
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || type.isUnion()) return false;
      if (this.checker.getIndexInfosOfType(type).length > 0) return false;
      const prop = this.checker.getPropertyOfType(type, key);
      // As in T3.6: `{}` and `object` written as types accept any object.
      if (!prop) {
        const isObject = (type.flags & ts.TypeFlags.Object) !== 0;
        const literal = ((type.symbol?.flags ?? 0) & ts.SymbolFlags.ObjectLiteral) !== 0;
        return isObject && (literal || this.checker.getPropertiesOfType(type).length > 0);
      }
      type = this.checker.getTypeOfSymbolAtLocation(prop, node);
    }
    return false;
  }

  /** The object at `path` of the call, or nothing when the argument is left out. */
  at(call: ts.CallExpression, path: string): ObjectRead | undefined {
    const v = valueAt(call, path, undefined);
    if (v && this.lacksKey(v.node, v.keys)) return undefined;
    if (v) return readObjectAt(this.checker, v.node, v.keys);
    return call.arguments.some((a) => ts.isSpreadElement(a))
      ? { properties: {}, open: 'the properties are in a spread argument' }
      : undefined;
  }

  /**
   * Person property names at `path`: the keys of an object, or, for the string form of
   * `people.set(name, value)`, the name itself when it is a literal.
   */
  names(call: ts.CallExpression, path: string): { names: string[]; open?: string } | undefined {
    const v = valueAt(call, path, undefined);
    if (v && v.keys.length === 0) {
      const type = this.checker.getTypeAtLocation(v.node);
      const members = type.isUnion() ? type.types : [type];
      if (members.every((t) => t.flags & ts.TypeFlags.StringLike)) {
        const literals = members.filter((t) => t.isStringLiteral());
        return literals.length === members.length
          ? { names: literals.map((t) => t.value) }
          : {
              names: [],
              open: `the property name has type \`${this.checker.typeToString(type, v.node)}\``,
            };
      }
    }
    const read = this.at(call, path);
    if (!read) return undefined;
    const names = Object.keys(read.properties);
    return read.open === undefined ? { names } : { names, open: read.open };
  }

  /**
   * The person properties an entry with `personSetFallback` sets: the `$set` object's keys when the
   * argument has one, and the argument's own keys (less `omit`) when it may not.
   */
  withFallback(
    call: ts.CallExpression,
    entry: MemberCall & { personSet: string },
  ): { names: string[]; open?: string } | undefined {
    const fallback = entry.personSetFallback;
    if (!fallback) return this.names(call, entry.personSet);
    const from = this.at(call, fallback.from);
    if (!from) return undefined;
    if (from.open !== undefined) return { names: Object.keys(from.properties), open: from.open };
    const set = from.properties.$set;
    const names = new Set<string>();
    let open: string | undefined;
    if (set) {
      const inner = this.names(call, entry.personSet);
      for (const n of inner?.names ?? []) names.add(n);
      open = inner?.open;
    }
    if (!set || set.presence === 'sometimes')
      for (const key of Object.keys(from.properties))
        if (key !== '$set' && !fallback.omit.includes(key)) names.add(key);
    return open === undefined ? { names: [...names] } : { names: [...names], open };
  }
}

/** The super and person properties a source's SDK calls set. */
export function resolveSuperProperties(
  sp: { program: ts.Program },
  calls: readonly SdkCall[],
): SuperScan {
  const reader = new SuperReader(sp.program.getTypeChecker());
  const supers = new Map<string, SuperProperty>();
  const persons = new Map<string, PersonProperty>();
  const openWorld: OpenWorldSite[] = [];
  let openSuperSites = 0;
  let openPersonSites = 0;

  for (const c of calls) {
    const { entry } = c;
    if (entry.superProperties !== undefined) {
      const read = reader.at(c.call, entry.superProperties);
      if (!read) continue;
      const site: CallSite = { file: c.file, line: c.line, call: entry.member };
      for (const [name, fact] of Object.entries(read.properties)) {
        const known = supers.get(name);
        supers.set(name, {
          presence: 'sometimes',
          values: known ? unionDomains(known.values, fact.values) : fact.values,
          sites: [...(known?.sites ?? []), site].sort(compareSites),
        });
      }
      if (read.open !== undefined) {
        openSuperSites++;
        openWorld.push({
          file: c.file,
          line: c.line,
          kind: 'properties',
          reason: `super properties: ${read.open}`,
        });
      }
    }
    for (const which of ['personSet', 'personSetOnce'] as const) {
      const path = entry[which];
      if (path === undefined) continue;
      const found =
        which === 'personSet'
          ? reader.withFallback(c.call, { ...entry, personSet: path })
          : reader.names(c.call, path);
      if (!found) continue;
      const site: CallSite = { file: c.file, line: c.line, call: personLabel(c, which) };
      for (const name of found.names) {
        const known = persons.get(name);
        persons.set(name, { sites: [...(known?.sites ?? []), site].sort(compareSites) });
      }
      if (found.open !== undefined) {
        openPersonSites++;
        openWorld.push({
          file: c.file,
          line: c.line,
          kind: 'properties',
          reason: `person properties: ${found.open}`,
        });
      }
    }
  }
  return {
    superProperties: byName(supers),
    personProperties: byName(persons),
    openSuperSites,
    openPersonSites,
    openWorld: openWorld.sort(compareSites),
  };
}
