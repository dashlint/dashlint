// Event names from types (spec 6.4 items 5 and 10, T3.5): a string literal gives one name, a union
// of literals or a string enum each of its names, a finite template literal its expansion; at a
// wrapper's call sites the argument's own type decides, so `trackShelf("shelf_opened")` is one
// name even when the parameter allows two. `string`, `any`, more than MAX_NAMES names or anything
// that is not a string makes the site open world with the reason (G15): counted, never guessed.
import ts from 'typescript';
import type { Coverage, OpenWorldSite } from '../formats/catalog.js';
import type { SourceProgram } from './program.js';
import { skipOuter } from './sdk-calls.js';
import { valueAt, type EventCall, type WrapperScan } from './wrappers.js';

/** At most this many names from one union or template literal (spec 6.4 item 5). */
export const MAX_NAMES = 50;

/** An event site whose name resolved: one name, or each name of a union. */
export interface NamedSite {
  event: EventCall;
  /** Sorted, distinct. */
  names: string[];
}

export type NameCoverage = Pick<
  Coverage,
  'callSites' | 'literalNameSites' | 'openSites' | 'nameResolutionRate'
>;

export interface NameScan {
  /** In the order of `WrapperScan.events`. */
  sites: NamedSite[];
  /** The wrapper scan's open world plus one `event-name` entry per unresolved site, in file order. */
  openWorld: OpenWorldSite[];
  coverage: NameCoverage;
}

/** An open name keeps the fixed head and tail it always has, when it has one (ADR-061). */
type Open = { reason: string } & Pick<OpenWorldSite, 'prefix' | 'suffix'>;

type Names = { names: string[] } | Open;

const NOTHING = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;

function sorted(names: Iterable<string>): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function tooMany(count: number): Open {
  return { reason: `event name is one of ${count} names, more than ${MAX_NAMES}` };
}

/** `open` with the head and tail every name it can be starts and ends with; empty ones are left out. */
function bounded(open: Open, prefix: string, suffix: string): Open {
  return { ...open, ...(prefix && { prefix }), ...(suffix && { suffix }) };
}

/** `literalNameSites / callSites` rounded to three decimals; 1 when there is no call site. */
export function nameResolutionRate(literalNameSites: number, callSites: number): number {
  return callSites === 0 ? 1 : Math.round((literalNameSites / callSites) * 1000) / 1000;
}

class NameResolver {
  constructor(private readonly checker: ts.TypeChecker) {}

  private typeText(type: ts.Type, at: ts.Node): string {
    return this.checker.typeToString(type, at);
  }

  /**
   * The string values a type can hold. `undefined` and `null` name no event and are dropped
   * (an optional name sends its literal or nothing); any other member that is not a string
   * literal (`string`, a number, a pattern template, a type parameter, `any`) makes it open.
   */
  ofType(type: ts.Type, at: ts.Node): Names {
    const members = type.isUnion() ? type.types : [type];
    const named = members.filter((t) => !(t.flags & NOTHING));
    if (named.length === 0 || named.some((t) => !t.isStringLiteral())) {
      const open = { reason: `event name has type \`${this.typeText(type, at)}\`` };
      const only = named.length === 1 ? named[0] : undefined;
      if (!only || !(only.flags & ts.TypeFlags.TemplateLiteral)) return open;
      // A pattern type (`shelf_${string}`) sends only names with its fixed head and tail.
      const { texts } = only as ts.TemplateLiteralType;
      return bounded(open, texts[0] ?? '', texts.at(-1) ?? '');
    }
    const names = sorted(named.map((t) => (t as ts.StringLiteralType).value));
    return names.length > MAX_NAMES ? tooMany(names.length) : { names };
  }

  /** The text a template part can become: string, number and boolean literals. */
  private partTexts(type: ts.Type): string[] | undefined {
    const texts: string[] = [];
    for (const t of type.isUnion() ? type.types : [type]) {
      if (t.isStringLiteral() || t.isNumberLiteral()) texts.push(String(t.value));
      else if (t.flags & ts.TypeFlags.BooleanLiteral) texts.push(this.checker.typeToString(t));
      else return undefined;
    }
    return texts;
  }

  /**
   * A template expression (`\`genre_${genre}_browsed\``) has type `string` unless it is
   * contextually typed, so it is expanded from its parts' types instead, up to MAX_NAMES. When it
   * stays open, its literal head and tail still bound the names it can send (ADR-061).
   */
  ofTemplate(e: ts.TemplateExpression): Names {
    const head = e.head.text;
    const tail = e.templateSpans.at(-1)?.literal.text ?? '';
    let names = [head];
    for (const span of e.templateSpans) {
      const type = this.checker.getTypeAtLocation(span.expression);
      const texts = this.partTexts(type);
      if (!texts) {
        const reason = `event name is a template with a part of type \`${this.typeText(type, span)}\``;
        return bounded({ reason }, head, tail);
      }
      const count = names.length * new Set(texts).size;
      if (count > MAX_NAMES) return bounded(tooMany(count), head, tail);
      names = names.flatMap((n) => texts.map((t) => n + t + span.literal.text));
    }
    return { names: sorted(names) };
  }

  /** The type of `keys` read from the value of `node`, or undefined when a key is not there. */
  private typeAt(node: ts.Expression, keys: readonly string[]): ts.Type | undefined {
    let type = this.checker.getTypeAtLocation(node);
    for (const key of keys) {
      const prop = this.checker.getPropertyOfType(this.checker.getNonNullableType(type), key);
      if (!prop) return undefined;
      type = this.checker.getTypeOfSymbolAtLocation(prop, node);
    }
    return type;
  }

  ofValue(node: ts.Expression, keys: readonly string[]): Names {
    const type = this.typeAt(node, keys);
    if (!type)
      return {
        reason: `event name is read from \`${keys.join('.')}\`, which its value does not have`,
      };
    const fromType = this.ofType(type, node);
    const e = skipOuter(node);
    if ('names' in fromType || keys.length > 0 || !ts.isTemplateExpression(e)) return fromType;
    return this.ofTemplate(e);
  }

  of(site: EventCall): Names {
    const ref = site.event;
    if ('literal' in ref) return { names: [ref.literal] };
    if ('node' in ref) return this.ofValue(ref.node, ref.keys);
    const v = valueAt(site.call, ref.arg, site.callee);
    if (v) return this.ofValue(v.node, v.keys);
    return site.call.arguments.some((a) => ts.isSpreadElement(a))
      ? { reason: 'the event name is in a spread argument' }
      : { reason: 'the call passes no event name' };
  }
}

function compareSites(a: OpenWorldSite, b: OpenWorldSite): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;
}

/**
 * The names of every event site of a source, the open-world sites whose name cannot be known, and
 * the name-resolution rate. A call site is one call, whatever number of names it gives. Open sites
 * are the `event-name` entries (unresolved names and wrapper chains cut off) and the calls from an
 * SDK import that does not resolve, which may be event calls: they lower the rate, never raise it.
 */
export function resolveEventNames(sp: SourceProgram, scan: WrapperScan): NameScan {
  const resolver = new NameResolver(sp.program.getTypeChecker());
  const sites: NamedSite[] = [];
  const open: OpenWorldSite[] = [];
  for (const event of scan.events) {
    const r = resolver.of(event);
    if ('names' in r) sites.push({ event, names: r.names });
    else open.push({ file: event.file, line: event.line, kind: 'event-name', ...r });
  }
  // Stable: entries already in file order keep their order on the same line.
  const openWorld = [...scan.openWorld, ...open].sort(compareSites);
  const openSites = openWorld.filter(
    (o) => o.kind === 'event-name' || o.kind === 'unresolved-import',
  ).length;
  const callSites = sites.length + openSites;
  return {
    sites,
    openWorld,
    coverage: {
      callSites,
      literalNameSites: sites.length,
      openSites,
      nameResolutionRate: nameResolutionRate(sites.length, callSites),
    },
  };
}
