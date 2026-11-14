// SDK calls matched by their resolved declaration (spec 6.4 item 3, T4, T3.3): `posthog.capture`,
// `ph.capture` and `const { capture } = usePostHog()` all resolve to the same declaration, while a
// local function that happens to be called `capture` resolves to the user's own code and is never
// a site. A call whose callee comes from an SDK import that does not resolve, or from an untyped
// binding that holds an SDK value (ADR-045), cannot be matched either way, so it is open world with
// the reason (G15), never a guess.
import { relative } from 'node:path';
import ts from 'typescript';
import {
  ambientModule,
  matchMember,
  memberKey,
  memberNames,
  PackageResolver,
  packageName,
  type Descriptor,
  type MemberCall,
} from '../descriptors/index.js';
import type { OpenWorldSite } from '../formats/catalog.js';
import type { SourceProgram } from './program.js';
import { UntypedClients } from './untyped.js';

export interface SdkCall {
  call: ts.CallExpression;
  /** Relative to the repository root, `/` separators. */
  file: string;
  /** The line of the called name (`capture` in `posthog\n  .capture(...)`). */
  line: number;
  descriptor: Descriptor;
  entry: MemberCall;
  /** `Container.member` of the resolved declaration, for the site's `via`. */
  declaration: string;
}

export interface SdkCallScan {
  /** In file order, then by position. */
  calls: SdkCall[];
  openWorld: OpenWorldSite[];
}

/** How far a callee is followed back to the import it comes from. */
const MAX_FOLLOW = 8;

export function skipOuter(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  )
    e = e.expression;
  return e;
}

// The token whose line a site records: the called name.
function calledNode(callee: ts.Expression): ts.Node {
  const e = skipOuter(callee);
  if (ts.isPropertyAccessExpression(e)) return e.name;
  if (ts.isElementAccessExpression(e)) return e.argumentExpression;
  return e;
}

export function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile();
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** The line a site records for a call: the line of the called name. */
export function callLine(call: ts.CallExpression): number {
  return lineOf(calledNode(call.expression));
}

// The member name a call uses, as written or as imported or destructured (`{ capture: track }`).
function calledName(callee: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const e = skipOuter(callee);
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e))
    return ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : undefined;
  if (!ts.isIdentifier(e)) return undefined;
  const decl = checker.getSymbolAtLocation(e)?.declarations?.[0];
  if (decl && (ts.isBindingElement(decl) || ts.isImportSpecifier(decl))) {
    const name = decl.propertyName ?? decl.name;
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
  }
  return e.text;
}

function moduleSpecifierOf(decl: ts.Declaration): ts.Expression | undefined {
  const n = ts.findAncestor(
    decl,
    (a) =>
      ts.isImportDeclaration(a) || ts.isExportDeclaration(a) || ts.isImportEqualsDeclaration(a),
  );
  if (!n) return undefined;
  if (!ts.isImportEqualsDeclaration(n)) return n.moduleSpecifier;
  return ts.isExternalModuleReference(n.moduleReference) ? n.moduleReference.expression : undefined;
}

// `require("x")` in a JavaScript file.
function requiredSpecifier(e: ts.Expression): ts.StringLiteralLike | undefined {
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
  if (e.expression.text !== 'require' || e.arguments.length !== 1) return undefined;
  const arg = e.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg : undefined;
}

/**
 * Follows a callee back to the import it comes from, through property accesses, calls (a hook's
 * result), `const` aliases, destructuring and re-exports, and returns the module specifier when
 * that import does not resolve.
 */
class ImportTracer {
  constructor(private readonly checker: ts.TypeChecker) {}

  unresolved(e: ts.Expression, seen = new Set<ts.Node>()): string | undefined {
    if (seen.size > MAX_FOLLOW) return undefined;
    e = skipOuter(e);
    const required = requiredSpecifier(e);
    if (required) return this.unresolvedModule(required);
    if (
      ts.isPropertyAccessExpression(e) ||
      ts.isElementAccessExpression(e) ||
      ts.isCallExpression(e)
    )
      return this.unresolved(e.expression, seen);
    if (!ts.isIdentifier(e)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(e);
    return symbol ? this.fromSymbol(symbol, seen) : undefined;
  }

  private unresolvedModule(specifier: ts.Expression): string | undefined {
    if (!ts.isStringLiteralLike(specifier)) return undefined;
    return this.checker.getSymbolAtLocation(specifier) ? undefined : specifier.text;
  }

  private fromSymbol(symbol: ts.Symbol, seen: Set<ts.Node>): string | undefined {
    const decl = symbol.declarations?.[0];
    if (!decl || seen.has(decl)) return undefined;
    seen.add(decl);
    // A variable first: in JavaScript `const x = require("y")` is an alias too.
    let holder: ts.Node = decl;
    while (ts.isBindingElement(holder) || ts.isObjectBindingPattern(holder)) holder = holder.parent;
    if (ts.isVariableDeclaration(holder))
      return holder.initializer ? this.unresolved(holder.initializer, seen) : undefined;
    if (!(symbol.flags & ts.SymbolFlags.Alias)) return undefined;
    const specifier = moduleSpecifierOf(decl);
    const missing = specifier ? this.unresolvedModule(specifier) : undefined;
    if (missing !== undefined) return missing;
    const next = this.checker.getImmediateAliasedSymbol(symbol);
    return next ? this.fromSymbol(next, seen) : undefined;
  }
}

const OBJECT_TYPE = ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.Intersection;

/**
 * The entry as this call uses it: its object form (ADR-055) when the argument the form reads from
 * has an object type, so `track({ event_type: "x" })` reads the name from `event_type`, and
 * Segment's `identify({ email })` reads the traits from `args[0]` (ADR-056). A name, `any`, a
 * union with a string, a spread or a missing argument keep the plain form, where a non-literal
 * name is open world.
 */
function asCalled(entry: MemberCall, call: ts.CallExpression, checker: ts.TypeChecker): MemberCall {
  const form = entry.objectForm;
  const from = form?.event ?? form?.personSet;
  if (!form || from === undefined) return entry;
  const index = Number(/^args\[(\d+)\]/.exec(from)?.[1] ?? NaN);
  const args = call.arguments.slice(0, index + 1);
  const arg = call.arguments[index];
  if (!arg || args.some((a) => ts.isSpreadElement(a))) return entry;
  const type = checker.getNonNullableType(checker.getTypeAtLocation(arg));
  const parts = type.isUnion() ? type.types : [type];
  if (!parts.every((t) => (t.flags & OBJECT_TYPE) !== 0)) return entry;
  const asObject: MemberCall = { ...entry };
  delete asObject.objectForm;
  if (form.event !== undefined) {
    asObject.event = form.event;
    delete asObject.properties;
    if (form.properties !== undefined) asObject.properties = form.properties;
  }
  if (form.personSet !== undefined) asObject.personSet = form.personSet;
  return asObject;
}

/**
 * Every call in the source's analysed files whose resolved declaration is an SDK member a
 * descriptor describes, and the calls that come from an unresolved SDK import (open world).
 * `descriptors` are all the loaded ones; the SDKs the source imports are tried first.
 */
export function findSdkCalls(sp: SourceProgram, descriptors: readonly Descriptor[]): SdkCallScan {
  const checker = sp.program.getTypeChecker();
  const imported = sp.sdks.map((s) => s.descriptor);
  const ordered = [
    ...descriptors.filter((d) => imported.includes(d)),
    ...descriptors.filter((d) => !imported.includes(d)),
  ];
  const packages = new PackageResolver();
  const tracer = new ImportTracer(checker);
  const calls: SdkCall[] = [];
  const openWorld: OpenWorldSite[] = [];

  const packageOf = (decl: ts.Node): string | undefined => {
    const ambient = ambientModule(decl);
    if (ambient !== undefined) return packageName(ambient);
    const sf = decl.getSourceFile();
    return sf.isDeclarationFile ? packages.packageOf(sf.fileName) : undefined;
  };
  const untypedClients = new UntypedClients(
    sp,
    checker,
    new Set(ordered.flatMap((d) => d.declaredIn)),
    packageOf,
  );
  const describedNames = new Set(ordered.flatMap((d) => [...memberNames(d)]));

  for (const fileName of sp.files) {
    const sf = sp.program.getSourceFile(fileName);
    if (!sf) continue;
    const file = relative(sp.repoRoot, fileName).replace(/\\/g, '/');
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration && !ts.isJSDocSignature(declaration)) {
          const key = memberKey(declaration);
          const pkg = key ? packageOf(declaration) : undefined;
          const match = key && pkg ? matchMember(ordered, pkg, key) : undefined;
          if (match)
            calls.push({
              call: node,
              file,
              line: lineOf(calledNode(node.expression)),
              ...match,
              entry: asCalled(match.entry, node, checker),
            });
        } else {
          const name = calledName(node.expression, checker);
          const described = (pkg: string | undefined): Descriptor | undefined =>
            ordered.find(
              (d) =>
                pkg !== undefined && d.declaredIn.includes(pkg) && memberNames(d).has(name ?? ''),
            );
          const specifier = tracer.unresolved(node.expression);
          const sdk = described(specifier === undefined ? undefined : packageName(specifier));
          // Only a described member name asks where an untyped receiver comes from.
          const untyped =
            !sdk && name !== undefined && describedNames.has(name)
              ? untypedClients.receiverOf(node.expression)
              : undefined;
          const viaUntyped = untyped ? described(untyped.pkg) : undefined;
          if (sdk)
            openWorld.push({
              file,
              line: lineOf(calledNode(node.expression)),
              kind: 'unresolved-import',
              reason: `\`${name}\` comes from "${specifier}", which does not resolve, so it may be a ${sdk.sdk} call`,
            });
          else if (untyped && viaUntyped)
            openWorld.push({
              file,
              line: lineOf(calledNode(node.expression)),
              kind: 'unresolved-import',
              reason: `\`${name}\` is called on \`${untyped.binding}\`, typed \`${untyped.type}\` but holding a value from "${untyped.pkg}", so it may be a ${viaUntyped.sdk} call`,
            });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { calls, openWorld };
}
