// Identity calls (spec 6.3.1 and 6.4, T3.7): `reset` and `identify`, each with the syntactic
// context it runs in. v0.1 records them and runs no check on them (spec 1 non-goals). The context
// is read from the enclosing functions only, ADR-027:
// - `module-init`: not inside any function (runs when the module loads);
// - `mount-effect`: in the callback of `useEffect` or `useLayoutEffect` with an empty dependency
//   list, or in a class's `componentDidMount`;
// - `handler`: in a JSX `on*` prop, an `addEventListener` callback, or a function whose name says it
//   handles something (`handleLogout`, `onPress`, `logout`, `signOut`);
// - `other`: anything else, such as a helper called from elsewhere or an effect with dependencies.
// Anonymous callbacks passed to other calls (`.then(...)`, `setTimeout`) are looked through.
import ts from 'typescript';
import type { IdentityCall, IdentityContext } from '../formats/catalog.js';
import type { SdkCall } from './sdk-calls.js';

type FunctionNode = ts.SignatureDeclaration & { body?: ts.Node };

const EFFECTS = new Set(['useEffect', 'useLayoutEffect']);
const HANDLER_NAME = /^(?:on|handle)[A-Z_]|log_?out|sign_?out/i;

function nameOf(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

function declaredName(fn: FunctionNode): string | undefined {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) return fn.name.text;
  const parent = fn.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
  )
    return parent.name.text;
  return undefined;
}

/** What one enclosing function says about the context, or undefined to look further out. */
function classify(fn: FunctionNode): IdentityContext | undefined {
  const parent = fn.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(fn as ts.Expression)) {
    const callee = nameOf(parent.expression);
    if (callee !== undefined && EFFECTS.has(callee) && parent.arguments[0] === fn) {
      const deps = parent.arguments[1];
      return deps && ts.isArrayLiteralExpression(deps) && deps.elements.length === 0
        ? 'mount-effect'
        : 'other';
    }
    if (callee === 'addEventListener') return 'handler';
    // An anonymous callback: the function that passes it decides.
    if (declaredName(fn) === undefined) return undefined;
  }
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
    const attr = parent.parent.name;
    return ts.isIdentifier(attr) && /^on[A-Z]/.test(attr.text) ? 'handler' : 'other';
  }
  const name = declaredName(fn);
  if (ts.isMethodDeclaration(fn) && name === 'componentDidMount') return 'mount-effect';
  if (name !== undefined && HANDLER_NAME.test(name)) return 'handler';
  return 'other';
}

/** The syntactic context of a call (ADR-027). */
export function identityContext(node: ts.Node): IdentityContext {
  for (let n: ts.Node = node.parent; !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionLike(n) && (n as FunctionNode).body !== undefined) {
      const found = classify(n as FunctionNode);
      if (found !== undefined) return found;
    }
  }
  // Only anonymous callbacks, or none, between the call and the module: it runs at load.
  for (let n: ts.Node = node.parent; !ts.isSourceFile(n); n = n.parent)
    if (ts.isFunctionLike(n) && (n as FunctionNode).body !== undefined) return 'other';
  return 'module-init';
}

/** The identity calls among a source's SDK calls, in file order. */
export function findIdentityCalls(calls: readonly SdkCall[]): IdentityCall[] {
  return calls.flatMap((c) =>
    c.entry.identity === undefined
      ? []
      : [{ call: c.entry.identity, file: c.file, line: c.line, context: identityContext(c.call) }],
  );
}
