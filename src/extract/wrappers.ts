// Wrappers to a fixed point (spec 6.4 item 4, T3.4): apps call their own `track()` helpers, not
// the SDK. A function, method or arrow function W whose body calls an event member (or another
// wrapper) with the event argument equal to one of W's parameters becomes a derived entry; the
// calls of W are then the sites and the call inside W is part of their `via`, never a site. A
// chain is followed at most MAX_DEPTH wrappers deep; each call of a wrapper that would go deeper
// is reported as open world with the cut-off and counted, never guessed.
import { relative } from 'node:path';
import ts from 'typescript';
import type { ArgPath, Descriptor, MemberCall } from '../descriptors/index.js';
import type { OpenWorldSite } from '../formats/catalog.js';
import type { SourceProgram } from './program.js';
import { callLine, findSdkCalls, lineOf, skipOuter, type SdkCallScan } from './sdk-calls.js';

/** How many wrappers deep a chain is followed (spec 6.4 item 4). */
export const MAX_DEPTH = 5;

/** How many aliases, destructurings and property reads are followed back to a parameter. */
const MAX_ALIAS = 8;

/** A value at a call: an argument path of the call, or an expression written inside a wrapper. */
export type ValueRef = { arg: ArgPath } | { node: ts.Expression; keys: string[] };

/**
 * Where an event name comes from at a call: an argument path, the SDK's fixed name, or a wrapper
 * parameter's default when the call leaves the argument out.
 */
export type EventRef = ValueRef | { literal: string };

/**
 * One piece of an event's properties object: an argument path of the call (the keys of its type),
 * an expression written inside a wrapper (the keys of its type, after `keys`), or one element of
 * an object literal a wrapper builds (`source: "web"` in `{ ...props, source: "web" }`, or a spread
 * of something other than the wrapper's parameter).
 */
export type PropertyPart = ValueRef | { element: ts.ObjectLiteralElementLike };

export type WrapperFunction =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

/** What calling a target sends, relative to the target's parameters. */
interface Target {
  descriptor: Descriptor;
  entry: MemberCall;
  event: EventRef;
  properties: PropertyPart[];
  addProperties: Record<string, ValueRef>;
  /** From this target down to the SDK member: `track (src/a.ts:3)`, `PostHog.capture`. */
  via: string[];
  /** 0 for the SDK member itself. */
  depth: number;
  fn?: WrapperFunction;
  /** The wrapper functions in this chain, so a recursive wrapper is not derived again. */
  chain: ReadonlySet<ts.Node>;
}

export interface Wrapper {
  declaration: WrapperFunction;
  /** `track (src/lib/analytics.ts:8)`, as `via` writes it. */
  label: string;
  /** 1 when the wrapper calls the SDK member itself. */
  depth: number;
  descriptor: Descriptor;
  entry: MemberCall;
  /** Relative to the wrapper's parameters, as `properties` and `addProperties` are. */
  event: { arg: ArgPath };
  properties: PropertyPart[];
  addProperties: Record<string, ValueRef>;
  via: string[];
}

/** An event site: an SDK event member called outside a wrapper role, or a call of a wrapper. */
export interface EventCall {
  call: ts.CallExpression;
  /** Relative to the repository root, `/` separators. */
  file: string;
  /** The line of the called name. */
  line: number;
  descriptor: Descriptor;
  /** The SDK entry at the end of the chain. */
  entry: MemberCall;
  /** Outermost wrapper first, the SDK member (`PostHog.capture`) last. */
  via: string[];
  /** Relative to `call`'s arguments, as `properties` and `addProperties` are. */
  event: EventRef;
  properties: PropertyPart[];
  addProperties: Record<string, ValueRef>;
  /** The outermost wrapper `call` calls, whose parameter defaults fill arguments left out. */
  callee?: WrapperFunction;
}

export interface WrapperScan {
  /** The SDK calls in the analysed files (T3.3), every role. */
  sdkCalls: SdkCallScan;
  /** Event sites in the analysed files, in file order, then by position. */
  events: EventCall[];
  wrappers: Wrapper[];
  /** The SDK scan's open-world entries plus one per depth cut-off, in file order. */
  openWorld: OpenWorldSite[];
  /** Calls not followed because their chain would be deeper than MAX_DEPTH. */
  cutOffs: number;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isWrapperFunction(node: ts.Node): node is WrapperFunction {
  return (
    ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body !== undefined) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function parsePath(path: ArgPath): { index: number; keys: string[] } {
  const [head = '', ...keys] = path.split('.');
  return { index: Number(/^args\[(\d+)\]$/.exec(head)?.[1] ?? NaN), keys };
}

function propertyName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)))
    return name.text;
  return undefined;
}

/** A parameter path of the function that declares the parameter. */
interface ParamPath {
  fn: WrapperFunction;
  path: ArgPath;
}

function withKeys(p: ParamPath | undefined, keys: readonly string[]): ParamPath | undefined {
  if (!p || !keys.every((k) => IDENTIFIER.test(k))) return undefined;
  return { fn: p.fn, path: [p.path, ...keys].join('.') };
}

/**
 * The value at `path` of a call: the argument, then each key read from an object literal where
 * the call writes one. Keys left over (the argument is not a literal there) are returned with the
 * expression. A missing argument is the parameter's default when the callee declares one; an
 * argument after a spread has no known position.
 */
export function valueAt(
  call: ts.CallExpression,
  path: ArgPath,
  callee: WrapperFunction | undefined,
): { node: ts.Expression; keys: string[] } | undefined {
  const { index, keys } = parsePath(path);
  const spread = call.arguments.findIndex((a) => ts.isSpreadElement(a));
  if (spread >= 0 && spread <= index) return undefined;
  let node = call.arguments[index] ?? callee?.parameters[index]?.initializer;
  if (!node) return undefined;
  const rest = [...keys];
  while (rest.length > 0) {
    const e = skipOuter(node);
    if (!ts.isObjectLiteralExpression(e)) break;
    // The last element that writes the key wins; a spread after it could override it, so stop.
    const found = [...e.properties]
      .reverse()
      .find((p) => ts.isSpreadAssignment(p) || propertyName(p.name) === rest[0]);
    if (found && ts.isPropertyAssignment(found)) node = found.initializer;
    else if (found && ts.isShorthandPropertyAssignment(found)) node = found.name;
    else break;
    rest.shift();
  }
  return { node, keys: rest };
}

/**
 * Follows an expression back to a parameter: directly, through `const` aliases and destructuring
 * (of the parameter or of a `const`), and through property reads (`p.name`).
 */
class ParamTracer {
  constructor(private readonly checker: ts.TypeChecker) {}

  of(expr: ts.Expression, steps = 0): ParamPath | undefined {
    if (steps > MAX_ALIAS) return undefined;
    const e = skipOuter(expr);
    if (ts.isPropertyAccessExpression(e))
      return withKeys(this.of(e.expression, steps + 1), [e.name.text]);
    if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))
      return withKeys(this.of(e.expression, steps + 1), [e.argumentExpression.text]);
    if (!ts.isIdentifier(e)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(e);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return decl ? this.fromDeclaration(decl, [], steps + 1) : undefined;
  }

  private fromDeclaration(decl: ts.Node, keys: string[], steps: number): ParamPath | undefined {
    if (ts.isParameter(decl)) {
      const fn = decl.parent;
      if (decl.dotDotDotToken || !isWrapperFunction(fn)) return undefined;
      return withKeys({ fn, path: `args[${fn.parameters.indexOf(decl)}]` }, keys);
    }
    if (ts.isBindingElement(decl)) {
      if (decl.dotDotDotToken || !ts.isObjectBindingPattern(decl.parent)) return undefined;
      const key = propertyName(decl.propertyName ?? decl.name);
      return key === undefined
        ? undefined
        : this.fromDeclaration(decl.parent.parent, [key, ...keys], steps);
    }
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isVariableDeclarationList(decl.parent) &&
      decl.parent.flags & ts.NodeFlags.Const
    )
      return withKeys(this.of(decl.initializer, steps), keys);
    return undefined;
  }
}

/** The implementation a resolved declaration stands for: an overload's body, or itself. */
function implementation(decl: ts.Node, checker: ts.TypeChecker): WrapperFunction | undefined {
  if (isWrapperFunction(decl)) return decl;
  if ((ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) && decl.name)
    return checker.getSymbolAtLocation(decl.name)?.declarations?.find(isWrapperFunction);
  return undefined;
}

/** The name `via` gives a wrapper: its own, its variable's or property's, or `Class.method`. */
function wrapperName(fn: WrapperFunction): string {
  if (ts.isMethodDeclaration(fn)) {
    const name = propertyName(fn.name) ?? '(computed)';
    const owner = ts.isClassLike(fn.parent) ? fn.parent.name?.text : undefined;
    return owner ? `${owner}.${name}` : name;
  }
  if (!ts.isArrowFunction(fn) && fn.name) return fn.name.text;
  // The variable or property that holds it, also through a call such as `useCallback(fn, deps)`.
  let holder: ts.Node = fn.parent;
  while (ts.isParenthesizedExpression(holder) || ts.isCallExpression(holder))
    holder = holder.parent;
  if (
    ts.isVariableDeclaration(holder) ||
    ts.isPropertyAssignment(holder) ||
    ts.isPropertyDeclaration(holder)
  )
    return propertyName(holder.name) ?? '(anonymous)';
  return '(anonymous)';
}

// User code the program loads beyond the analysed files (a shared `lib/` the source imports):
// wrappers declared there count, but nothing in it is a site of this source. Files the source
// skips (tests, build output, excluded) are not user code here either.
function outsideFiles(sp: SourceProgram): string[] {
  const analysed = new Set(sp.files);
  const skipped = new Set(Object.values(sp.skipped).flat());
  const repoFile = (sf: ts.SourceFile): string =>
    relative(sp.repoRoot, sf.fileName).replace(/\\/g, '/');
  return sp.program
    .getSourceFiles()
    .filter(
      (sf) =>
        !sf.isDeclarationFile &&
        !analysed.has(sf.fileName) &&
        !sf.fileName.split('/').includes('node_modules') &&
        !repoFile(sf).startsWith('..') &&
        !skipped.has(repoFile(sf)),
    )
    .map((sf) => sf.fileName)
    .sort();
}

function compareSites(
  a: { file: string; line: number },
  b: { file: string; line: number },
): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line;
}

/**
 * The event sites of a source: every event member call followed through the wrappers that pass
 * the event name on, until nothing changes or a chain reaches MAX_DEPTH. Members without an event
 * role (super and person properties, identity) are in `sdkCalls` and not followed here.
 */
export function followWrappers(sp: SourceProgram, descriptors: readonly Descriptor[]): WrapperScan {
  const checker = sp.program.getTypeChecker();
  const params = new ParamTracer(checker);
  const analysed = new Set(sp.files);
  const outside = outsideFiles(sp);
  const sdkCalls = findSdkCalls(sp, descriptors);
  const outsideCalls = findSdkCalls({ ...sp, files: outside }, descriptors);
  const relativeFile = (node: ts.Node): string =>
    relative(sp.repoRoot, node.getSourceFile().fileName).replace(/\\/g, '/');

  // Every call whose resolved declaration is a function with a body in user code.
  const callsTo = new Map<ts.Node, ts.CallExpression[]>();
  for (const fileName of [...sp.files, ...outside]) {
    const sf = sp.program.getSourceFile(fileName);
    if (!sf) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const decl = checker.getResolvedSignature(node)?.declaration;
        const fn = decl && !ts.isJSDocSignature(decl) ? implementation(decl, checker) : undefined;
        if (fn && !fn.getSourceFile().isDeclarationFile)
          callsTo.set(fn, [...(callsTo.get(fn) ?? []), node]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // A value the target reads at `call`, as seen from the function `fn` that makes the call.
  const translate = (v: { node: ts.Expression; keys: string[] }, fn: WrapperFunction): ValueRef => {
    const p = withKeys(params.of(v.node), v.keys);
    return p && p.fn === fn ? { arg: p.path } : { node: v.node, keys: v.keys };
  };

  const translateParts = (
    call: ts.CallExpression,
    target: Target,
    fn: WrapperFunction,
  ): PropertyPart[] =>
    target.properties.flatMap((part): PropertyPart[] => {
      if (!('arg' in part)) return [part];
      const v = valueAt(call, part.arg, target.fn);
      if (!v) return [];
      const e = skipOuter(v.node);
      if (v.keys.length > 0 || !ts.isObjectLiteralExpression(e)) return [translate(v, fn)];
      return e.properties.map((element) => {
        const p = ts.isSpreadAssignment(element) ? params.of(element.expression) : undefined;
        return p && p.fn === fn ? { arg: p.path } : { element };
      });
    });

  const events: EventCall[] = [];
  const wrappers: Wrapper[] = [];
  const cutOffSites: OpenWorldSite[] = [];
  const cutCalls = new Set<ts.CallExpression>();
  const queue: { call: ts.CallExpression; target: Target }[] = [];

  for (const c of [...sdkCalls.calls, ...outsideCalls.calls]) {
    const { entry } = c;
    if (entry.event === undefined) continue;
    queue.push({
      call: c.call,
      target: {
        descriptor: c.descriptor,
        entry,
        event: typeof entry.event === 'string' ? { arg: entry.event } : entry.event,
        properties: [entry.properties ?? []].flat().map((arg) => ({ arg })),
        addProperties: Object.fromEntries(
          Object.entries(entry.addProperties ?? {}).map(([k, arg]) => [k, { arg }]),
        ),
        via: [c.declaration],
        depth: 0,
        chain: new Set(),
      },
    });
  }

  for (const { call, target } of queue) {
    const ev = 'arg' in target.event ? valueAt(call, target.event.arg, target.fn) : undefined;
    const mapped = ev ? withKeys(params.of(ev.node), ev.keys) : undefined;

    if (!mapped) {
      if (analysed.has(call.getSourceFile().fileName))
        events.push({
          call,
          file: relativeFile(call),
          line: callLine(call),
          descriptor: target.descriptor,
          entry: target.entry,
          via: target.via,
          event: target.event,
          properties: target.properties,
          addProperties: target.addProperties,
          ...(target.fn ? { callee: target.fn } : {}),
        });
      continue;
    }
    const fn = mapped.fn;
    // A wrapper that calls itself passes the name on to a chain already followed.
    if (target.chain.has(fn)) continue;
    const name = wrapperName(fn);
    const label = `${name} (${relativeFile(fn)}:${lineOf(fn.name ?? fn)})`;
    if (target.depth >= MAX_DEPTH) {
      // Each call of `fn` would be a site (or lead to one): open world where it is lost.
      for (const c of callsTo.get(fn) ?? []) {
        if (cutCalls.has(c)) continue;
        cutCalls.add(c);
        cutOffSites.push({
          file: relativeFile(c),
          line: callLine(c),
          kind: 'event-name',
          reason: `the event name passes through more than ${MAX_DEPTH} wrappers (${[label, ...target.via].join(' > ')}), so this call is not followed`,
        });
      }
      continue;
    }
    const addProperties: Record<string, ValueRef> = {};
    for (const [k, ref] of Object.entries(target.addProperties)) {
      const v = 'arg' in ref ? valueAt(call, ref.arg, target.fn) : ref;
      if (v) addProperties[k] = 'arg' in ref ? translate(v, fn) : ref;
    }
    const wrapper: Wrapper = {
      declaration: fn,
      label,
      depth: target.depth + 1,
      descriptor: target.descriptor,
      entry: target.entry,
      event: { arg: mapped.path },
      properties: translateParts(call, target, fn),
      addProperties,
      via: [label, ...target.via],
    };
    wrappers.push(wrapper);
    const next: Target = { ...wrapper, fn, chain: new Set([...target.chain, fn]) };
    for (const c of callsTo.get(fn) ?? []) queue.push({ call: c, target: next });
  }

  events.sort(
    (a, b) =>
      compareSites(a, b) ||
      a.call.getStart() - b.call.getStart() ||
      a.via.join().localeCompare(b.via.join()),
  );
  wrappers.sort((a, b) => a.via.join().localeCompare(b.via.join()));
  const openWorld = [...sdkCalls.openWorld, ...cutOffSites].sort(compareSites);
  return { sdkCalls, events, wrappers, openWorld, cutOffs: cutOffSites.length };
}
