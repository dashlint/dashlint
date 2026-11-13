// SDK clients held in untyped bindings (ADR-045, T11.2a). A call on an `any` or `unknown` receiver
// has no declaration, so it can never be matched; when that binding holds a value that comes from
// the SDK (an import, `require` or `import()` of an SDK package, `new` of an SDK class, a value of an
// SDK type, or a member of one), the calls of described members on it may be event calls. They are
// open world, never sites: this only withholds "no", it never adds an event. Bindings that never
// hold an SDK value give nothing, so no member is ever matched by its name alone.
import ts from 'typescript';
import { packageName } from '../descriptors/index.js';
import type { SourceProgram } from './program.js';

/** A described member called on a binding that holds an SDK value without a type. */
export interface UntypedCall {
  /** The receiver as written (`this.client`, `client`, `getClient()`). */
  binding: string;
  /** `any` or `unknown`. */
  type: string;
  /** The SDK package the binding's value comes from. */
  pkg: string;
}

/** How far a value is followed back to where it comes from. */
const MAX_FOLLOW = 8;
/** Rounds of marking: a binding can take its SDK value from another marked binding. */
const MAX_ROUNDS = 5;

function skipOuter(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isAwaitExpression(e)
  )
    e = e.expression;
  return e;
}

const FALLBACK = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

// `Promise.all([import("x"), ...])` and its siblings: the result holds what the arguments hold.
function combined(e: ts.Expression): boolean {
  if (!ts.isCallExpression(e)) return false;
  const callee = skipOuter(e.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Promise' &&
    ['all', 'allSettled', 'any', 'race'].includes(callee.name.text)
  );
}

// `{ a }`, `[a]` and their elements, up to the declaration that holds the pattern.
function isBindingPart(node: ts.Node): boolean {
  return (
    ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)
  );
}

function isUntyped(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

// `require("x")` and `import("x")`.
function loadedSpecifier(e: ts.Expression): string | undefined {
  if (!ts.isCallExpression(e) || e.arguments.length !== 1) return undefined;
  const loads =
    e.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(e.expression) && e.expression.text === 'require');
  const arg = e.arguments[0];
  return loads && arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

// The node that names a function-like, for a function whose return type is untyped.
function functionName(fn: ts.SignatureDeclaration): ts.Node | undefined {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) return fn.name;
  const holder = fn.parent;
  if (
    ts.isVariableDeclaration(holder) ||
    ts.isPropertyDeclaration(holder) ||
    ts.isPropertyAssignment(holder)
  )
    return holder.name;
  return undefined;
}

export class UntypedClients {
  private readonly marked = new Map<ts.Symbol, string>();
  private scanned = false;

  /**
   * @param sdkPackages every package a loaded descriptor declares its members in.
   * @param packageOf the SDK package a declaration belongs to, as call matching reads it.
   */
  constructor(
    private readonly sp: SourceProgram,
    private readonly checker: ts.TypeChecker,
    private readonly sdkPackages: ReadonlySet<string>,
    private readonly packageOf: (decl: ts.Node) => string | undefined,
  ) {}

  /** The untyped binding a call's receiver comes from, when that binding holds an SDK value. */
  receiverOf(callee: ts.Expression): UntypedCall | undefined {
    if (!this.scanned) this.scan();
    if (this.marked.size === 0) return undefined;
    const e = skipOuter(callee);
    const receiver =
      ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? e.expression : e;
    return this.markedRoot(receiver, new Set());
  }

  private symbolOf(node: ts.Node): ts.Symbol | undefined {
    const at = ts.isPropertyAccessExpression(node) ? node.name : node;
    return this.checker.getSymbolAtLocation(at);
  }

  private hit(sym: ts.Symbol | undefined, node: ts.Node): UntypedCall | undefined {
    const pkg = sym ? this.marked.get(sym) : undefined;
    if (!sym || pkg === undefined) return undefined;
    const type = this.checker.getTypeOfSymbol(sym);
    const shown = isUntyped(type) ? this.checker.typeToString(type) : 'any';
    return { binding: node.getText(), type: shown, pkg };
  }

  // Back from a receiver along property accesses, calls and aliases to a marked binding.
  private markedRoot(expr: ts.Expression, seen: Set<ts.Node>): UntypedCall | undefined {
    if (seen.size > MAX_FOLLOW) return undefined;
    const e = skipOuter(expr);
    if (ts.isPropertyAccessExpression(e))
      return this.hit(this.symbolOf(e), e) ?? this.markedRoot(e.expression, seen);
    if (ts.isElementAccessExpression(e)) return this.markedRoot(e.expression, seen);
    if (ts.isCallExpression(e)) {
      const callee = skipOuter(e.expression);
      return this.hit(this.symbolOf(callee), e) ?? this.markedRoot(callee, seen);
    }
    if (!ts.isIdentifier(e)) return undefined;
    const sym = this.symbolOf(e);
    const found = this.hit(sym, e);
    if (found) return found;
    const holder = this.variableOf(sym, seen);
    return holder?.initializer ? this.markedRoot(holder.initializer, seen) : undefined;
  }

  // The variable declaration a symbol is declared by, through destructuring.
  private variableOf(
    sym: ts.Symbol | undefined,
    seen: Set<ts.Node>,
  ): ts.VariableDeclaration | undefined {
    const decl = sym?.declarations?.[0];
    if (!decl || seen.has(decl)) return undefined;
    seen.add(decl);
    let holder: ts.Node = decl;
    while (isBindingPart(holder)) holder = holder.parent;
    return ts.isVariableDeclaration(holder) ? holder : undefined;
  }

  /** The SDK package a value comes from, or undefined. */
  private origin(expr: ts.Expression, seen: Set<ts.Node>): string | undefined {
    if (seen.size > MAX_FOLLOW) return undefined;
    const e = skipOuter(expr);
    const loaded = loadedSpecifier(e);
    if (loaded !== undefined) return this.sdk(packageName(loaded));
    const typed = this.typedOrigin(e);
    if (typed !== undefined) return typed;
    // Either side may hold the client: `m?.default ?? m`, `a || b`, `c ? a : b`, `[a, b]`.
    const parts = ts.isBinaryExpression(e)
      ? FALLBACK.has(e.operatorToken.kind)
        ? [e.left, e.right]
        : []
      : ts.isConditionalExpression(e)
        ? [e.whenTrue, e.whenFalse]
        : ts.isArrayLiteralExpression(e)
          ? [...e.elements]
          : combined(e)
            ? [...(e as ts.CallExpression).arguments]
            : undefined;
    if (parts) {
      for (const part of parts) {
        const pkg = this.origin(part, seen);
        if (pkg !== undefined) return pkg;
      }
      return undefined;
    }
    if (ts.isNewExpression(e)) return this.origin(e.expression, seen);
    if (
      ts.isCallExpression(e) ||
      ts.isPropertyAccessExpression(e) ||
      ts.isElementAccessExpression(e)
    )
      return this.origin(e.expression, seen);
    if (!ts.isIdentifier(e)) return undefined;
    const sym = this.checker.getSymbolAtLocation(e);
    if (!sym) return undefined;
    const marked = this.marked.get(sym);
    if (marked !== undefined) return marked;
    const decl = sym.declarations?.[0];
    if (!decl) return undefined;
    if (sym.flags & ts.SymbolFlags.Alias) return this.importedFrom(decl);
    const holder = this.variableOf(sym, seen);
    if (holder?.initializer) return this.origin(holder.initializer, seen);
    return this.thenParameter(decl, seen);
  }

  private sdk(pkg: string | undefined): string | undefined {
    return pkg !== undefined && this.sdkPackages.has(pkg) ? pkg : undefined;
  }

  // A value whose type is declared by an SDK package (a client typed `PostHog`).
  private typedOrigin(e: ts.Expression): string | undefined {
    const type = this.checker.getTypeAtLocation(e);
    if (isUntyped(type)) return undefined;
    const sym = type.aliasSymbol ?? type.getSymbol();
    for (const decl of sym?.declarations ?? []) {
      const pkg = this.sdk(this.packageOf(decl));
      if (pkg !== undefined) return pkg;
    }
    return undefined;
  }

  private importedFrom(decl: ts.Declaration): string | undefined {
    const n = ts.findAncestor(
      decl,
      (a) => ts.isImportDeclaration(a) || ts.isImportEqualsDeclaration(a),
    );
    if (!n) return undefined;
    const specifier = ts.isImportDeclaration(n)
      ? n.moduleSpecifier
      : ts.isExternalModuleReference(n.moduleReference)
        ? n.moduleReference.expression
        : undefined;
    return specifier && ts.isStringLiteralLike(specifier)
      ? this.sdk(packageName(specifier.text))
      : undefined;
  }

  // The parameter of a callback given to `.then` on an SDK value: `import("x").then((m) => ...)`.
  private thenParameter(decl: ts.Declaration, seen: Set<ts.Node>): string | undefined {
    let param: ts.Node = decl;
    while (isBindingPart(param)) param = param.parent;
    if (!ts.isParameter(param)) return undefined;
    const fn = param.parent;
    const call = fn.parent;
    if (!ts.isCallExpression(call) || !call.arguments.some((a) => a === fn)) return undefined;
    const callee = skipOuter(call.expression);
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'then'
      ? this.origin(callee.expression, seen)
      : undefined;
  }

  // Marks every untyped binding that is given an SDK value, until nothing changes.
  private scan(): void {
    this.scanned = true;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let changed = false;
      const mark = (target: ts.Node | undefined, value: ts.Expression | undefined): void => {
        if (!target || !value) return;
        const sym = this.symbolOf(target);
        if (!sym || this.marked.has(sym) || !isUntyped(this.checker.getTypeOfSymbol(sym))) return;
        const pkg = this.origin(value, new Set());
        if (pkg === undefined) return;
        this.marked.set(sym, pkg);
        changed = true;
      };
      const returned = (fn: ts.SignatureDeclaration | undefined, value: ts.Expression): void => {
        const name = fn ? functionName(fn) : undefined;
        const signature = fn ? this.checker.getSignatureFromDeclaration(fn) : undefined;
        if (!name || !signature || !isUntyped(this.checker.getReturnTypeOfSignature(signature)))
          return;
        const sym = this.checker.getSymbolAtLocation(name);
        if (!sym || this.marked.has(sym)) return;
        const pkg = this.origin(value, new Set());
        if (pkg === undefined) return;
        this.marked.set(sym, pkg);
        changed = true;
      };
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          mark(node.name, node.initializer);
        } else if (ts.isPropertyDeclaration(node)) {
          mark(node.name, node.initializer);
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          (ts.isIdentifier(node.left) || ts.isPropertyAccessExpression(node.left))
        ) {
          mark(node.left, node.right);
        } else if (ts.isReturnStatement(node) && node.expression) {
          returned(
            ts.findAncestor(node.parent, ts.isFunctionLike) as ts.SignatureDeclaration | undefined,
            node.expression,
          );
        } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
          returned(node, node.body);
        } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
          const declaration = this.checker.getResolvedSignature(node)?.declaration;
          if (declaration && !ts.isJSDocSignature(declaration))
            node.arguments.forEach((arg, i) => {
              const param = declaration.parameters[i];
              if (param && !param.dotDotDotToken && !param.getSourceFile().isDeclarationFile)
                mark(param.name, arg);
            });
        }
        ts.forEachChild(node, visit);
      };
      for (const fileName of this.sp.files) {
        const sf = this.sp.program.getSourceFile(fileName);
        if (sf) visit(sf);
      }
      if (!changed) return;
    }
  }
}
