// Builtins (spec 6.4 item 8, T3.7, ADR-003, ADR-027): what each SDK a source uses sends by itself,
// with conditions evaluated on the init options. The init sites are the descriptor's `init`
// entries: a member call or constructor matched by its resolved declaration, or a provider
// component's options prop. An option decides only when every init site gives it a literal (or
// leaves it out of a closed object literal, which keeps the SDK default); otherwise the builtin is
// conditional, never "not sent" (G15). With no init site in the source, every option-conditioned
// builtin is conditional.
import { relative } from 'node:path';
import ts from 'typescript';
import {
  ambientModule,
  isInitComponent,
  MODULE_CONTAINER,
  moduleFunctionName,
  PackageResolver,
  packageName,
  type AutoCaller,
  type BuiltinCondition,
  type Descriptor,
  type InitEntry,
} from '../descriptors/index.js';
import type { Builtins, JsonScalar } from '../formats/catalog.js';
import type { SourceProgram } from './program.js';
import { findSdkCalls, lineOf, skipOuter, type SdkCallScan } from './sdk-calls.js';

/** How far `const` aliases of an options object are followed. */
const MAX_ALIAS = 8;

/** An option as the code sets it: left out, a literal, a non-literal truthy value, or unknown. */
export type OptionValue =
  | { kind: 'absent' }
  | { kind: 'value'; value: JsonScalar }
  | { kind: 'object' }
  | { kind: 'unknown'; reason: string };

/** Where an SDK client is created, and the options it is given. */
export interface InitSite {
  file: string;
  line: number;
  descriptor: Descriptor;
  options: InitOptions;
}

/** No options passed (every option keeps its default), an expression, or unknown with the reason. */
export type InitOptions =
  | { kind: 'none' }
  | { kind: 'expression'; node: ts.Expression }
  | { kind: 'unknown'; reason: string };

export type BuiltinState = 'sent' | 'off' | 'conditional';

export interface BuiltinProperty {
  name: string;
  events: '*' | string[];
  presence: 'always' | 'sometimes';
}

export interface BuiltinScan {
  /** The catalog's `builtins` (spec 6.3.1): sent events, the table, conditional names. */
  builtins: Builtins;
  /** Builtin properties that are sent, sorted by name. */
  properties: BuiltinProperty[];
  /** Builtin event and property names decided not sent (an option turns them off), sorted. */
  off: string[];
  inits: InitSite[];
  /** Where the SDK may call a `call` condition's member by itself (ADR-047). */
  autos: AutoSite[];
}

function sorted(names: Iterable<string>): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
}

export class OptionReader {
  constructor(private readonly checker: ts.TypeChecker) {}

  private fromType(node: ts.Expression): OptionValue {
    const t = this.checker.getTypeAtLocation(node);
    if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { kind: 'absent' };
    if (t.isStringLiteral() || t.isNumberLiteral()) return { kind: 'value', value: t.value };
    if (t.flags & ts.TypeFlags.BooleanLiteral)
      return { kind: 'value', value: this.checker.typeToString(t) === 'true' };
    if (t.flags & ts.TypeFlags.Null) return { kind: 'value', value: null };
    return {
      kind: 'unknown',
      reason: `the option has type \`${this.checker.typeToString(t, node)}\``,
    };
  }

  /** A `const` the identifier names, followed to its initializer. */
  private constInitializer(e: ts.Identifier): ts.Expression | undefined {
    let symbol = this.checker.getSymbolAtLocation(e);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = this.checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    return ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const ? decl.initializer : undefined;
  }

  /** The value at `path` inside `node`; `path` empty reads `node` itself. */
  read(node: ts.Expression, path: readonly string[], steps = 0): OptionValue {
    const e = skipOuter(node);
    if (ts.isIdentifier(e)) {
      if (e.text === 'undefined') return { kind: 'absent' };
      const init = steps < MAX_ALIAS ? this.constInitializer(e) : undefined;
      if (init) return this.read(init, path, steps + 1);
      return path.length === 0
        ? this.fromType(e)
        : { kind: 'unknown', reason: `the options are \`${e.text}\`, not an object literal` };
    }
    if (ts.isObjectLiteralExpression(e)) {
      if (path.length === 0) return { kind: 'object' };
      const [key, ...rest] = path;
      // The last element that writes the key wins; a spread after it may override it.
      const found = [...e.properties]
        .reverse()
        .find(
          (p) =>
            ts.isSpreadAssignment(p) ||
            (p.name !== undefined && propertyName(p.name as ts.PropertyName) === key),
        );
      if (!found) return { kind: 'absent' };
      if (ts.isSpreadAssignment(found))
        return { kind: 'unknown', reason: `a spread in the options may set \`${key}\`` };
      if (ts.isPropertyAssignment(found)) return this.read(found.initializer, rest, steps);
      if (ts.isShorthandPropertyAssignment(found)) return this.read(found.name, rest, steps);
      // A method or accessor: a function value is truthy; an accessor's value is unknown.
      return ts.isMethodDeclaration(found) && rest.length === 0
        ? { kind: 'object' }
        : { kind: 'unknown', reason: `\`${key}\` is an accessor` };
    }
    if (path.length > 0)
      return { kind: 'unknown', reason: 'the options are not an object literal' };
    if (e.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'value', value: true };
    if (e.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'value', value: false };
    if (e.kind === ts.SyntaxKind.NullKeyword) return { kind: 'value', value: null };
    if (ts.isStringLiteralLike(e)) return { kind: 'value', value: e.text };
    if (ts.isNumericLiteral(e)) return { kind: 'value', value: Number(e.text) };
    if (ts.isArrayLiteralExpression(e) || ts.isArrowFunction(e) || ts.isFunctionExpression(e))
      return { kind: 'object' };
    return this.fromType(e);
  }
}

/** Whether one init site sends a builtin with this condition (ADR-003). */
function stateFor(
  when: Exclude<BuiltinCondition, 'always' | { unknown: string } | CallCondition>,
  v: OptionValue,
): BuiltinState {
  if (v.kind === 'unknown') return 'conditional';
  if ('not' in when) {
    if (v.kind === 'value' && v.value === when.not) return 'off';
    return 'sent';
  }
  if (when.is === true) {
    if (v.kind === 'object') return 'sent';
    if (v.kind === 'value') return v.value ? 'sent' : 'off';
    return 'off';
  }
  return v.kind === 'value' && v.value === when.is ? 'sent' : 'off';
}

/** A `call` condition (ADR-047). */
export type CallCondition = Extract<BuiltinCondition, { call: string }>;

/**
 * Whether a builtin is sent in a source with these init sites: sent when any init site sends it
 * (some code path does), otherwise conditional when any is undecided, otherwise off. A `call`
 * condition is the reader's to decide (conditional when it cannot).
 */
export function evaluateCondition(
  when: BuiltinCondition,
  inits: readonly InitSite[],
  reader: {
    option(init: InitSite, option: string): OptionValue;
    call?(when: CallCondition): BuiltinState;
  },
): BuiltinState {
  if (when === 'always') return 'sent';
  if ('unknown' in when) return 'conditional';
  if ('call' in when) return reader.call ? reader.call(when) : 'conditional';
  if (inits.length === 0) return 'conditional';
  const states = inits.map((init) => stateFor(when, reader.option(init, when.option)));
  if (states.includes('sent')) return 'sent';
  return states.includes('conditional') ? 'conditional' : 'off';
}

function initMatches(entry: InitEntry, container: string, member: string): boolean {
  return !isInitComponent(entry) && entry.member === member && entry.on.includes(container);
}

/** The container and member of a constructor, method or module-level function declaration. */
function declarationKey(decl: ts.Node): { container: string; member: string } | undefined {
  const fn = moduleFunctionName(decl);
  if (fn !== undefined) return { container: MODULE_CONTAINER, member: fn };
  const parent = decl.parent;
  if (!parent || !(ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent)) || !parent.name)
    return undefined;
  if (ts.isConstructorDeclaration(decl))
    return { container: parent.name.text, member: 'constructor' };
  if (
    (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) &&
    (ts.isIdentifier(decl.name) || ts.isStringLiteral(decl.name))
  )
    return { container: parent.name.text, member: decl.name.text };
  return undefined;
}

/**
 * The options argument of a call at `args[i]`, or a reason it cannot be known. Given several
 * positions, the last one the call passes holds the options (ADR-055).
 */
export function optionsArgument(
  args: readonly ts.Expression[] | undefined,
  path: string | readonly string[],
): InitOptions {
  const list = args ?? [];
  const indexes = [path]
    .flat()
    .map((p) => Number(/^args\[(\d+)\]/.exec(p)?.[1] ?? NaN))
    .sort((a, b) => a - b);
  const spread = list.findIndex((a) => ts.isSpreadElement(a));
  if (spread >= 0 && spread <= (indexes.at(-1) ?? 0))
    return { kind: 'unknown', reason: 'the options are in a spread argument' };
  const index = [...indexes].reverse().find((i) => list[i] !== undefined);
  const node = index === undefined ? undefined : list[index];
  return node ? { kind: 'expression', node } : { kind: 'none' };
}

/** A place where the SDK may call a member for the app by itself (an `auto` caller, ADR-047). */
export interface AutoSite {
  file: string;
  line: number;
  descriptor: Descriptor;
  caller: AutoCaller;
  /** `off` only when a literal turns the caller's option off. */
  state: 'off' | 'conditional';
}

/** The `auto` callers of a descriptor's `call` conditions. */
function autoCallers(d: Descriptor): AutoCaller[] {
  const b = d.builtins;
  return [...b.events, ...b.properties, ...b.personProperties].flatMap((row) =>
    row.when !== 'always' && 'call' in row.when ? (row.when.auto ?? []) : [],
  );
}

/** Whether a literal turns `option` off: the whole value `false`, or `{ [option]: false }`. */
function turnsOff(reader: OptionReader, node: ts.Expression, option: string): boolean {
  const whole = reader.read(node, []);
  if (whole.kind === 'value') return whole.value === false;
  const v = reader.read(node, [option]);
  return v.kind === 'value' && v.value === false;
}

/** Init sites of the source's SDKs in its analysed files (descriptor `init` entries). */
export function findInitSites(sp: SourceProgram): InitSite[] {
  return scanInits(sp).inits;
}

/** Init sites and `auto` callers of the source's SDKs in its analysed files. */
function scanInits(sp: SourceProgram): { inits: InitSite[]; autos: AutoSite[] } {
  const checker = sp.program.getTypeChecker();
  const reader = new OptionReader(checker);
  const all = sp.sdks.map((s) => s.descriptor);
  const descriptors = all.filter((d) => d.init !== undefined);
  const callers = new Map(all.map((d) => [d, autoCallers(d)]));
  const anyCallers = [...callers.values()].some((c) => c.length > 0);
  const autos: AutoSite[] = [];
  const packages = new PackageResolver();
  const packageOf = (decl: ts.Node): string | undefined => {
    const ambient = ambientModule(decl);
    if (ambient !== undefined) return packageName(ambient);
    const sf = decl.getSourceFile();
    return sf.isDeclarationFile ? packages.packageOf(sf.fileName) : undefined;
  };
  const ownerIn = (list: readonly Descriptor[], decl: ts.Node): Descriptor[] => {
    const pkg = packageOf(decl);
    return pkg === undefined ? [] : list.filter((d) => d.declaredIn.includes(pkg));
  };
  const owner = (decl: ts.Node): Descriptor[] => ownerIn(descriptors, decl);
  const sites: InitSite[] = [];

  for (const fileName of sp.files) {
    const sf = sp.program.getSourceFile(fileName);
    if (!sf) continue;
    const file = relative(sp.repoRoot, fileName).replace(/\\/g, '/');
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const decl = checker.getResolvedSignature(node)?.declaration;
        const key = decl && !ts.isJSDocSignature(decl) ? declarationKey(decl) : undefined;
        if (decl && key) memberCaller(node, decl, key, file);
        if (decl && key)
          for (const d of owner(decl)) {
            const entry = d.init?.find((e) => initMatches(e, key.container, key.member));
            if (entry && !isInitComponent(entry)) {
              sites.push({
                file,
                line: lineOf(node),
                descriptor: d,
                options: optionsArgument(node.arguments, entry.options),
              });
              break;
            }
          }
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (anyCallers) componentCaller(node, file);
        const site = componentSite(node, file);
        if (site) sites.push(site);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { inits: sites, autos };

  function memberCaller(
    node: ts.CallExpression | ts.NewExpression,
    decl: ts.Node,
    key: { container: string; member: string },
    file: string,
  ): void {
    if (!ts.isCallExpression(node)) return;
    for (const d of ownerIn(all, decl))
      for (const caller of callers.get(d) ?? []) {
        if ('component' in caller) continue;
        if (caller.member !== key.member || !caller.on.includes(key.container)) continue;
        const options = optionsArgument(node.arguments, caller.options);
        const off = options.kind === 'expression' && turnsOff(reader, options.node, caller.option);
        autos.push({
          file,
          line: lineOf(node),
          descriptor: d,
          caller,
          state: off ? 'off' : 'conditional',
        });
      }
  }

  function componentCaller(
    node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    file: string,
  ): void {
    let symbol = checker.getSymbolAtLocation(node.tagName);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.declarations?.[0];
    if (!decl || !symbol) return;
    const attrs = node.attributes.properties;
    for (const d of ownerIn(all, decl))
      for (const caller of callers.get(d) ?? []) {
        if (!('component' in caller) || caller.component !== symbol.name) continue;
        const prop = attrs.find(
          (a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === caller.prop,
        );
        // A spread may set the prop; a missing prop keeps the default; `prop` alone is `true`.
        const init = prop && ts.isJsxAttribute(prop) ? prop.initializer : undefined;
        const off =
          !attrs.some((a) => ts.isJsxSpreadAttribute(a)) &&
          init !== undefined &&
          ts.isJsxExpression(init) &&
          init.expression !== undefined &&
          turnsOff(reader, init.expression, caller.option);
        autos.push({
          file,
          line: lineOf(node),
          descriptor: d,
          caller,
          state: off ? 'off' : 'conditional',
        });
      }
  }

  function componentSite(
    node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    file: string,
  ): InitSite | undefined {
    let symbol = checker.getSymbolAtLocation(node.tagName);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.declarations?.[0];
    if (!decl || !symbol) return undefined;
    for (const d of owner(decl)) {
      const entry = d.init?.find((e) => isInitComponent(e) && e.component === symbol.name);
      if (!entry || !isInitComponent(entry)) continue;
      const attrs = node.attributes.properties;
      const named = (n: string) =>
        attrs.find((a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === n);
      const base = { file, line: lineOf(node), descriptor: d };
      if (attrs.some((a) => ts.isJsxSpreadAttribute(a)))
        return {
          ...base,
          options: { kind: 'unknown', reason: 'the provider props are in a spread' },
        };
      // Given a client, the provider does not create one: its init is elsewhere.
      if (named('client')) return undefined;
      const options = named(entry.options);
      if (!options || !ts.isJsxAttribute(options)) return { ...base, options: { kind: 'none' } };
      const init = options.initializer;
      if (init && ts.isJsxExpression(init) && init.expression)
        return { ...base, options: { kind: 'expression', node: init.expression } };
      return {
        ...base,
        options: { kind: 'unknown', reason: `the ${entry.options} prop is not an expression` },
      };
    }
    return undefined;
  }
}

/**
 * A `call` condition in one source (ADR-047): sent when a call site of the member resolves to the
 * SDK; conditional when an open-world call may be one, or an `auto` caller is not turned off by a
 * literal, or the source creates no client and has no `auto` caller (the app's client and provider
 * are elsewhere); otherwise off.
 */
export function callState(
  when: CallCondition,
  descriptor: Descriptor,
  calls: Pick<SdkCallScan, 'calls' | 'openCalls'>,
  autos: readonly AutoSite[],
  inits: readonly InitSite[],
): BuiltinState {
  const named = (c: { descriptor: Descriptor; member: string }) =>
    c.descriptor === descriptor && c.member === when.call;
  if (calls.calls.some((c) => named({ descriptor: c.descriptor, member: c.entry.member })))
    return 'sent';
  if (calls.openCalls.some(named)) return 'conditional';
  const own = autos.filter((a) => a.descriptor === descriptor && when.auto?.includes(a.caller));
  if (own.some((a) => a.state === 'conditional')) return 'conditional';
  return own.length === 0 && inits.length === 0 ? 'conditional' : 'off';
}

/**
 * Builtins of the source's SDKs with their conditions evaluated on the source's init sites, and
 * `call` conditions on its SDK calls (found here when `calls` is not given).
 */
export function resolveBuiltins(
  sp: SourceProgram,
  calls: Pick<SdkCallScan, 'calls' | 'openCalls'> = findSdkCalls(
    sp,
    sp.sdks.map((s) => s.descriptor),
  ),
): BuiltinScan {
  const reader = new OptionReader(sp.program.getTypeChecker());
  const { inits, autos } = scanInits(sp);
  const option = (init: InitSite, name: string): OptionValue => {
    if (init.options.kind === 'none') return { kind: 'absent' };
    if (init.options.kind === 'unknown') return init.options;
    return reader.read(init.options.node, name.split('.'));
  };
  const events: string[] = [];
  const conditional: string[] = [];
  const off: string[] = [];
  const properties: BuiltinProperty[] = [];
  const tables: string[] = [];
  for (const { descriptor, sdk } of sp.sdks) {
    const own = inits.filter((i) => i.descriptor === descriptor);
    const call = (when: CallCondition) => callState(when, descriptor, calls, autos, own);
    const evaluate = (when: BuiltinCondition) => evaluateCondition(when, own, { option, call });
    const major = (sdk.version ?? descriptor.verified).split('.')[0];
    tables.push(`${descriptor.sdk}@${major}`);
    for (const b of descriptor.builtins.events) {
      const state = evaluate(b.when);
      (state === 'sent' ? events : state === 'off' ? off : conditional).push(b.name);
    }
    for (const b of descriptor.builtins.properties) {
      const state = evaluate(b.when);
      if (state === 'sent')
        properties.push({ name: b.name, events: b.events, presence: b.presence });
      else (state === 'off' ? off : conditional).push(b.name);
    }
    for (const b of descriptor.builtins.personProperties) {
      const state = evaluate(b.when);
      if (state !== 'sent') (state === 'off' ? off : conditional).push(b.name);
    }
  }
  // A name two SDKs disagree on: sent by either is sent; otherwise undecided by either is conditional.
  const sent = new Set([...events, ...properties.map((p) => p.name)]);
  const undecided = new Set(conditional.filter((n) => !sent.has(n)));
  return {
    builtins: {
      events: sorted(events),
      properties: tables.length > 0 ? sorted(tables).join(' ') : null,
      conditional: sorted(undecided),
    },
    properties: properties.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    off: sorted(off.filter((n) => !sent.has(n) && !undecided.has(n))),
    inits,
    autos,
  };
}
