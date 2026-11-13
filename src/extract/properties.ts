// Properties and values (spec 6.4 item 6, T3.6): what each event site sends. An object literal at
// the call (or one a wrapper builds) is read element by element, so `channel: 'link'` keeps its
// literal; any other value is read from its type. An optional property, a conditional spread or a
// value that may be `undefined` is sent `sometimes`, everything else `always`. Values are a finite
// set of JSON values (string, number, boolean and null literals, `boolean`, enums; at most
// MAX_VALUES) or open with a primitive type. An index signature, `any`, `unknown`, a type
// parameter or a spread of such a value makes the site's properties open (G15): the properties it
// lists are still sent, but "no" facts about its event stay unknown.
import ts from 'typescript';
import type {
  CatalogEvent,
  JsonScalar,
  OpenValueType,
  OpenWorldSite,
  Presence,
  PropertyFact,
  ValueDomain,
} from '../formats/catalog.js';
import type { NamedSite, NameScan } from './names.js';
import { skipOuter } from './sdk-calls.js';
import { valueAt, type PropertyPart, type ValueRef } from './wrappers.js';

/** At most this many values in a finite set (spec 6.3.1). */
export const MAX_VALUES = 50;

/** The properties one event site sends. */
export interface PropertySite {
  site: NamedSite;
  /** Sorted by name. */
  properties: Record<string, PropertyFact>;
  /** The site may send properties not listed, or other values for those listed. */
  openProperties: boolean;
}

export interface PropertyScan {
  /** In the order of `NameScan.sites`. */
  sites: PropertySite[];
  /** The name scan's open world plus one `properties` entry per open site, in file order. */
  openWorld: OpenWorldSite[];
}

/** A fact about a property on an event (spec 6.3.1): three-valued, "no" only when certain. */
export type PropertyFactValue = 'yes' | 'no' | 'unknown';

/**
 * What a value can be: a domain, plus whether it may be `undefined` (not sent). `domain` is
 * undefined when the value can only be `undefined`.
 */
interface Value {
  domain: ValueDomain | undefined;
  maybeMissing: boolean;
}

/**
 * Facts while reading, before values that are only `undefined` are dropped. `written` is whether
 * the key is written to the object; `mayUnset` whether the value written may be `undefined`, which
 * is not sent (so a later `key: undefined` removes an earlier value).
 */
interface Draft {
  written: Presence;
  domain: ValueDomain | undefined;
  mayUnset: boolean;
}

type Bag = Map<string, Draft>;

/** A properties value read: its properties, and the reason it is open when it is. */
interface Read {
  bag: Bag;
  open?: string;
}

const MISSING = ts.TypeFlags.Undefined | ts.TypeFlags.Void;
/** A type parameter, `T[K]`, a conditional type: what the value is depends on each use. */
const TYPE_PARAMETER = ts.TypeFlags.InstantiableNonPrimitive;

const KIND_ORDER = { string: 0, number: 1, boolean: 2, object: 3 } as const;

function scalarKind(v: JsonScalar): keyof typeof KIND_ORDER {
  return v === null ? 'object' : (typeof v as 'string' | 'number' | 'boolean');
}

/** Strings by code point, then numbers ascending, then `true`, `false`, then `null`. */
function compareScalars(a: JsonScalar, b: JsonScalar): number {
  const ka = KIND_ORDER[scalarKind(a)];
  const kb = KIND_ORDER[scalarKind(b)];
  if (ka !== kb) return ka - kb;
  if (typeof a === 'boolean') return a === b ? 0 : a ? -1 : 1;
  if (a === null || b === null) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The primitive type shared by a set's values, `null` aside; `unknown` when they differ. */
function typeOfSet(set: readonly JsonScalar[]): OpenValueType {
  const kinds = new Set(set.filter((v) => v !== null).map((v) => typeof v));
  return kinds.size === 1 ? ([...kinds][0] as OpenValueType) : 'unknown';
}

function finite(values: Iterable<JsonScalar>): ValueDomain {
  const set = [...new Set(values)].sort(compareScalars);
  return set.length > MAX_VALUES ? { kind: 'open', type: typeOfSet(set) } : { kind: 'finite', set };
}

function openType(d: ValueDomain): OpenValueType {
  return d.kind === 'open' ? d.type : typeOfSet(d.set);
}

/** Every value either domain holds. */
export function unionDomains(a: ValueDomain, b: ValueDomain): ValueDomain {
  if (a.kind === 'finite' && b.kind === 'finite') return finite([...a.set, ...b.set]);
  const ta = openType(a);
  const tb = openType(b);
  // `null` in a finite set does not change the open type (`string | null` is open `string`).
  const onlyNull = (d: ValueDomain): boolean =>
    d.kind === 'finite' && d.set.every((v) => v === null);
  const type = ta === tb ? ta : onlyNull(a) ? tb : onlyNull(b) ? ta : 'unknown';
  return { kind: 'open', type };
}

function unionMaybe(
  a: ValueDomain | undefined,
  b: ValueDomain | undefined,
): ValueDomain | undefined {
  return a && b ? unionDomains(a, b) : (a ?? b);
}

/**
 * A later write of a key over an earlier one, as object spread does: a key always written replaces
 * the earlier value (even with `undefined`); a key sometimes written leaves the earlier one in
 * place the other times.
 */
function overwrite(bag: Bag, key: string, next: Draft): void {
  const prev = bag.get(key);
  if (!prev || next.written === 'always') bag.set(key, next);
  else
    bag.set(key, {
      written: prev.written,
      domain: unionMaybe(prev.domain, next.domain),
      mayUnset: prev.mayUnset || next.mayUnset,
    });
}

function sometimes(bag: Bag): Bag {
  return new Map([...bag].map(([k, d]) => [k, { ...d, written: 'sometimes' as const }]));
}

/** One value of several types (the members of a union): a key is always sent only if every member always sends it. */
function alternatives(reads: readonly Read[]): Read {
  const keys = new Set(reads.flatMap((r) => [...r.bag.keys()]));
  const bag: Bag = new Map();
  for (const key of keys) {
    const drafts = reads.map((r) => r.bag.get(key));
    const present = drafts.filter((d): d is Draft => d !== undefined);
    bag.set(key, {
      written: drafts.every((d) => d?.written === 'always') ? 'always' : 'sometimes',
      domain: present.map((d) => d.domain).reduce(unionMaybe, undefined),
      mayUnset: present.some((d) => d.mayUnset),
    });
  }
  const open = reads.find((r) => r.open !== undefined)?.open;
  return open === undefined ? { bag } : { bag, open };
}

class PropertyReader {
  constructor(private readonly checker: ts.TypeChecker) {}

  private text(type: ts.Type, at: ts.Node): string {
    return this.checker.typeToString(type, at);
  }

  private isNothing(t: ts.Type): boolean {
    return (t.flags & (MISSING | ts.TypeFlags.Null)) !== 0;
  }

  /** `false`, `""` and `0`: what `cond && { ... }` is when the condition fails; spreads nothing. */
  private isFalsyLiteral(t: ts.Type): boolean {
    if (t.isStringLiteral()) return t.value === '';
    if (t.isNumberLiteral()) return t.value === 0;
    return (
      (t.flags & ts.TypeFlags.BooleanLiteral) !== 0 && this.checker.typeToString(t) === 'false'
    );
  }

  /** `string`, `number`, `bigint`, `any` and `unknown` hold falsy values (`boolean` is `true | false`). */
  private mayBeFalsy(t: ts.Type): boolean {
    const wide =
      ts.TypeFlags.String |
      ts.TypeFlags.Number |
      ts.TypeFlags.BigInt |
      ts.TypeFlags.Any |
      ts.TypeFlags.Unknown |
      ts.TypeFlags.InstantiableNonPrimitive;
    return (t.flags & wide) !== 0;
  }

  private literal(t: ts.Type): { value: JsonScalar } | undefined {
    if (t.isStringLiteral() || t.isNumberLiteral()) return { value: t.value };
    if (t.flags & ts.TypeFlags.BooleanLiteral)
      return { value: this.checker.typeToString(t) === 'true' };
    if (t.flags & ts.TypeFlags.Null) return { value: null };
    return undefined;
  }

  private primitive(t: ts.Type): OpenValueType {
    if (t.flags & ts.TypeFlags.StringLike) return 'string';
    if (t.flags & ts.TypeFlags.NumberLike) return 'number';
    if (t.flags & ts.TypeFlags.BooleanLike) return 'boolean';
    if (this.checker.isArrayType(t) || this.checker.isTupleType(t)) return 'array';
    if (t.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive) || t.isIntersection())
      return 'object';
    return 'unknown';
  }

  /** The values a property of this type can have. */
  value(type: ts.Type): Value {
    const members = type.isUnion() ? type.types : [type];
    const maybeMissing = members.some((t) => (t.flags & MISSING) !== 0);
    const sent = members.filter((t) => !(t.flags & MISSING));
    if (sent.length === 0) return { domain: undefined, maybeMissing: true };
    if (sent.some((t) => t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
      return { domain: { kind: 'open', type: 'unknown' }, maybeMissing };
    const literals = sent.map((t) => this.literal(t));
    if (literals.every((l) => l !== undefined))
      return { domain: finite(literals.map((l) => l.value)), maybeMissing };
    const types = new Set(
      sent.filter((t) => !(t.flags & ts.TypeFlags.Null)).map((t) => this.primitive(t)),
    );
    const only = types.size === 1 ? [...types][0] : undefined;
    return { domain: { kind: 'open', type: only ?? 'unknown' }, maybeMissing };
  }

  private draft(v: Value, optional = false): Draft {
    return {
      written: optional ? 'sometimes' : 'always',
      domain: v.domain,
      mayUnset: v.maybeMissing,
    };
  }

  private typeAt(node: ts.Expression, keys: readonly string[]): ts.Type | undefined {
    let type = this.checker.getTypeAtLocation(node);
    for (const key of keys) {
      // A key of `any` is `any`: its reason names the type rather than a missing key.
      if (type.flags & ts.TypeFlags.Any) return type;
      const prop = this.checker.getPropertyOfType(this.checker.getNonNullableType(type), key);
      if (!prop) return undefined;
      type = this.checker.getTypeOfSymbolAtLocation(prop, node);
    }
    return type;
  }

  /** The properties of one object type (not a union). */
  private ofObject(t: ts.Type, at: ts.Node): Read {
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      return { bag: new Map(), open: `the properties have type \`${this.text(t, at)}\`` };
    if (t.flags & TYPE_PARAMETER)
      return {
        bag: new Map(),
        open: `the properties have type \`${this.text(t, at)}\`, a type parameter`,
      };
    if (this.primitive(t) !== 'object')
      return {
        bag: new Map(),
        open: `the properties have type \`${this.text(t, at)}\`, not an object`,
      };
    if (this.checker.getIndexInfosOfType(t).length > 0)
      return {
        bag: new Map(),
        open: `the properties have type \`${this.text(t, at)}\`, which has an index signature`,
      };
    const props = this.checker.getPropertiesOfType(t);
    // `{}` and `object` written as types accept any object; only an object literal is known empty.
    if (props.length === 0 && !(t.symbol && t.symbol.flags & ts.SymbolFlags.ObjectLiteral))
      return {
        bag: new Map(),
        open: `the properties have type \`${this.text(t, at)}\`, which accepts any object`,
      };
    const bag: Bag = new Map();
    for (const prop of props) {
      const name = prop.getName();
      // Symbol and private keys are never sent.
      if (name.startsWith('__@') || name.startsWith('__#')) continue;
      const v = this.value(this.checker.getTypeOfSymbolAtLocation(prop, at));
      bag.set(name, this.draft(v, (prop.flags & ts.SymbolFlags.Optional) !== 0));
    }
    // `T & { items: number }` sends `items` and whatever each use gives `T`.
    if (t.isIntersection() && t.types.some((m) => m.flags & TYPE_PARAMETER))
      return {
        bag,
        open: `the properties have type \`${this.text(t, at)}\`, which includes a type parameter`,
      };
    return { bag };
  }

  /**
   * The properties a value of this type sends. `null`, `undefined` and (spread with `&&`) the
   * falsy literals send nothing, so the other members' properties become `sometimes`.
   */
  ofType(type: ts.Type, at: ts.Node): Read {
    const members = type.isUnion() ? type.types : [type];
    const empty = members.some((t) => this.isNothing(t) || this.isFalsyLiteral(t));
    const objects = members.filter((t) => !this.isNothing(t) && !this.isFalsyLiteral(t));
    if (objects.length === 0) return { bag: new Map() };
    const read = alternatives(objects.map((t) => this.ofObject(t, at)));
    return empty ? { ...read, bag: sometimes(read.bag) } : read;
  }

  /** A key written as `[expr]`: its literal names, each `sometimes` when there are several. */
  private computedKeys(name: ts.ComputedPropertyName): string[] | undefined {
    const type = this.checker.getTypeAtLocation(name.expression);
    const members = type.isUnion() ? type.types : [type];
    const keys = members.map((t) =>
      t.isStringLiteral() || t.isNumberLiteral() ? String(t.value) : undefined,
    );
    return keys.every((k) => k !== undefined) ? keys : undefined;
  }

  /** One element of an object literal written at the call or inside a wrapper, applied to `into`. */
  element(e: ts.ObjectLiteralElementLike, into: Read): void {
    if (ts.isSpreadAssignment(e)) {
      this.apply(into, this.ofValue(e.expression, []));
      return;
    }
    let keys: string[];
    if (ts.isComputedPropertyName(e.name)) {
      const computed = this.computedKeys(e.name);
      if (!computed) {
        const type = this.checker.getTypeAtLocation(e.name.expression);
        into.open ??= `a property name has type \`${this.text(type, e)}\``;
        return;
      }
      keys = computed;
    } else if (ts.isPrivateIdentifier(e.name)) return;
    else keys = [e.name.text];
    let draft: Draft;
    if (ts.isPropertyAssignment(e))
      draft = this.draft(this.value(this.checker.getTypeAtLocation(e.initializer)));
    else if (ts.isShorthandPropertyAssignment(e)) {
      // The name's own type is the object literal's widened one; the variable keeps its literals.
      const symbol = this.checker.getShorthandAssignmentValueSymbol(e);
      const type = symbol
        ? this.checker.getTypeOfSymbolAtLocation(symbol, e.name)
        : this.checker.getTypeAtLocation(e.name);
      draft = this.draft(this.value(type));
    }
    // A method is a function value; an accessor's value is whatever the getter returns.
    else if (ts.isMethodDeclaration(e))
      draft = { written: 'always', domain: { kind: 'open', type: 'object' }, mayUnset: false };
    else draft = { written: 'always', domain: { kind: 'open', type: 'unknown' }, mayUnset: false };
    // `{ [k]: v }` with `k: 'a' | 'b'` writes one of the keys.
    if (keys.length > 1) draft = { ...draft, written: 'sometimes' };
    for (const key of keys) overwrite(into.bag, key, draft);
  }

  /** Writes `next` over `into`, as a later spread does. */
  apply(into: Read, next: Read): void {
    for (const [key, draft] of next.bag) overwrite(into.bag, key, draft);
    if (next.open !== undefined) into.open ??= next.open;
  }

  /** The properties of a value: an object literal element by element, anything else by its type. */
  ofValue(node: ts.Expression, keys: readonly string[]): Read {
    const e = skipOuter(node);
    // The checker widens literals inside an object literal (`{ method: 'card' }` has type
    // `{ method: string }`), so literals and the branches that choose between them are read here.
    if (keys.length === 0 && ts.isObjectLiteralExpression(e)) {
      const read: Read = { bag: new Map() };
      for (const element of e.properties) this.element(element, read);
      return read;
    }
    if (keys.length === 0 && ts.isConditionalExpression(e))
      return alternatives([this.ofValue(e.whenTrue, []), this.ofValue(e.whenFalse, [])]);
    if (
      keys.length === 0 &&
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      // `cond && { ... }` sends the object when `cond` holds and nothing when it is falsy.
      const read = this.ofValue(e.right, []);
      const left = this.checker.getTypeAtLocation(e.left);
      const members = left.isUnion() ? left.types : [left];
      const canFail = members.some(
        (t) => this.isNothing(t) || this.isFalsyLiteral(t) || this.mayBeFalsy(t),
      );
      return canFail ? { ...read, bag: sometimes(read.bag) } : read;
    }
    const type = this.typeAt(node, keys);
    if (!type)
      return {
        bag: new Map(),
        open: `the properties are read from \`${keys.join('.')}\`, which their value does not have`,
      };
    return this.ofType(type, node);
  }

  /** A value the SDK adds as one property (`$screen_name` from the screen name). */
  private added(call: ts.CallExpression, ref: ValueRef, site: NamedSite): Draft | undefined {
    const v = 'arg' in ref ? valueAt(call, ref.arg, site.event.callee) : ref;
    if (!v) return undefined;
    const type = this.typeAt(v.node, v.keys);
    return type
      ? this.draft(this.value(type))
      : { written: 'sometimes', domain: { kind: 'open', type: 'unknown' }, mayUnset: true };
  }

  of(site: NamedSite): Read {
    const { call, properties, addProperties, callee } = site.event;
    const read: Read = { bag: new Map() };
    for (const part of properties) this.apply(read, this.part(call, part, callee));
    for (const [key, ref] of Object.entries(addProperties)) {
      const draft = this.added(call, ref, site);
      if (draft) overwrite(read.bag, key, draft);
      else if (call.arguments.some((a) => ts.isSpreadElement(a)))
        read.open ??= 'the call passes its arguments in a spread';
    }
    return read;
  }

  private part(
    call: ts.CallExpression,
    part: PropertyPart,
    callee: NamedSite['event']['callee'],
  ): Read {
    if ('element' in part) {
      const read: Read = { bag: new Map() };
      this.element(part.element, read);
      return read;
    }
    if ('node' in part) return this.ofValue(part.node, part.keys);
    const v = valueAt(call, part.arg, callee);
    if (v) return this.ofValue(v.node, v.keys);
    // An argument left out with no default sends nothing; one at or after a spread is unknown.
    return call.arguments.some((a) => ts.isSpreadElement(a))
      ? { bag: new Map(), open: 'the properties are in a spread argument' }
      : { bag: new Map() };
  }
}

/**
 * Facts sorted by name: `always` when the key is always written with a value that is never
 * `undefined`. A value that can only be `undefined` is never sent and is dropped.
 */
function facts(bag: Bag): Record<string, PropertyFact> {
  const out: Record<string, PropertyFact> = {};
  const sorted = [...bag].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, d] of sorted)
    if (d.domain)
      out[key] = {
        presence: d.written === 'always' && !d.mayUnset ? 'always' : 'sometimes',
        values: d.domain,
      };
  return out;
}

function compareSites(a: OpenWorldSite, b: OpenWorldSite): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;
}

/**
 * The properties of every named event site of a source, and one `properties` open-world entry per
 * site whose properties are open, with the reason.
 */
export function resolveProperties(
  sp: { program: ts.Program },
  names: Pick<NameScan, 'sites' | 'openWorld'>,
): PropertyScan {
  const reader = new PropertyReader(sp.program.getTypeChecker());
  const sites: PropertySite[] = [];
  const open: OpenWorldSite[] = [];
  for (const site of names.sites) {
    const read = reader.of(site);
    sites.push({ site, properties: facts(read.bag), openProperties: read.open !== undefined });
    if (read.open !== undefined)
      open.push({
        file: site.event.file,
        line: site.event.line,
        kind: 'properties',
        reason: read.open,
      });
  }
  const openWorld = [...names.openWorld, ...open].sort(compareSites);
  return { sites, openWorld };
}

/**
 * The properties of one event from the sites that send it (spec 6.3.1 and 6.4 item 11): a
 * property is `always` only when every site sends it always; values are every site's values.
 * `openSites` counts the sites whose properties are open.
 */
export function mergeSiteProperties(
  sites: readonly Pick<PropertySite, 'properties' | 'openProperties'>[],
): Pick<CatalogEvent, 'openSites' | 'properties'> {
  const keys = [...new Set(sites.flatMap((s) => Object.keys(s.properties)))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const properties: Record<string, PropertyFact> = {};
  for (const key of keys) {
    const each = sites.map((s) => s.properties[key]);
    const present = each.filter((f): f is PropertyFact => f !== undefined);
    properties[key] = {
      presence: each.every((f) => f?.presence === 'always') ? 'always' : 'sometimes',
      values: present.map((f) => f.values).reduce(unionDomains),
    };
  }
  return { openSites: sites.filter((s) => s.openProperties).length, properties };
}

/**
 * Whether an event's own sites send a property (spec 6.3.1): "yes" when listed, "no" when not
 * listed and no site's properties are open, otherwise "unknown". Super properties and builtins
 * (T3.7) can still turn a "no" here into "yes" or "unknown".
 */
export function eventPropertyFact(
  event: Pick<CatalogEvent, 'openSites' | 'properties'>,
  name: string,
): PropertyFactValue {
  if (Object.hasOwn(event.properties, name)) return 'yes';
  return event.openSites === 0 ? 'no' : 'unknown';
}
