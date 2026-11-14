// Which descriptor entry a resolved declaration belongs to (spec 6.4 item 3, T4, T3.3): the
// package that declares it, the container and the member name, never the identifier at the call.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { isHook, MODULE_CONTAINER, type Descriptor, type MemberCall } from './model.js';

/** Where a member is declared: `PostHog`, `PostHogCore` or `PostHog.people` and the member name. */
export interface MemberKey {
  container: string;
  member: string;
}

export interface DescriptorMatch {
  descriptor: Descriptor;
  entry: MemberCall;
  /** `Container.member`, as the catalog's `via` writes it. */
  declaration: string;
}

/** `posthog-js/react` to `posthog-js`, `@posthog/core/dist/x` to `@posthog/core`. */
export function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier === '') return undefined;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0];
}

function nameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name))
    return name.text;
  return undefined;
}

// The container of a member: the class, interface or type alias that declares it, or, for a
// member of an object-typed property, `Container.property`.
function containerOf(member: ts.Node): string | undefined {
  const parent = member.parent;
  if (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent))
    return parent.name ? parent.name.text : undefined;
  if (ts.isTypeLiteralNode(parent)) {
    const holder = parent.parent;
    if (ts.isTypeAliasDeclaration(holder)) return holder.name.text;
    if (ts.isPropertySignature(holder) || ts.isPropertyDeclaration(holder)) {
      const outer = containerOf(holder);
      const name = nameText(holder.name);
      return outer && name ? `${outer}.${name}` : undefined;
    }
  }
  return undefined;
}

type MemberNode =
  ts.MethodDeclaration | ts.MethodSignature | ts.PropertySignature | ts.PropertyDeclaration;

function isPropertyHolder(node: ts.Node): node is MemberNode {
  return ts.isPropertySignature(node) || ts.isPropertyDeclaration(node);
}

function atModuleLevel(statement: ts.Node): boolean {
  const parent = statement.parent;
  return (
    ts.isSourceFile(parent) || (ts.isModuleBlock(parent) && ts.isStringLiteral(parent.parent.name))
  );
}

/**
 * A function declared at module level, in a file or a `declare module` block (ADR-054), or a
 * module-level `const` whose type is written as a function type or an object type of call
 * signatures (`export declare const track: (...) => ...`, `init: { (...): ...; (...): ... }`,
 * ADR-055).
 */
export function moduleFunctionName(declaration: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(declaration))
    return declaration.name && atModuleLevel(declaration) ? declaration.name.text : undefined;
  let holder: ts.Node | undefined;
  if (ts.isFunctionTypeNode(declaration)) holder = declaration.parent;
  else if (ts.isCallSignatureDeclaration(declaration) && ts.isTypeLiteralNode(declaration.parent))
    holder = declaration.parent.parent;
  if (!holder || !ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name))
    return undefined;
  const list = holder.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return undefined;
  return ts.isVariableStatement(list.parent) && atModuleLevel(list.parent)
    ? holder.name.text
    : undefined;
}

/**
 * The container and member of a resolved signature declaration: a method, a function type or
 * function expression held by a property (`set: (prop) => void`), or a module-level function or
 * function-typed `const` (container `(module)`). Anything else (a local arrow function) has no member key. Which package
 * declares it is the caller's check, so a user's own module-level function never matches.
 */
export function memberKey(declaration: ts.Node): MemberKey | undefined {
  const fn = moduleFunctionName(declaration);
  if (fn !== undefined) return { container: MODULE_CONTAINER, member: fn };
  let member: MemberNode;
  if (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) {
    member = declaration;
  } else if (
    (ts.isFunctionTypeNode(declaration) ||
      ts.isArrowFunction(declaration) ||
      ts.isFunctionExpression(declaration)) &&
    isPropertyHolder(declaration.parent)
  ) {
    member = declaration.parent;
  } else {
    return undefined;
  }
  const name = nameText(member.name);
  if (name === undefined) return undefined;
  const container = containerOf(member);
  return container === undefined ? undefined : { container, member: name };
}

/** The module a declaration sits in when it is inside `declare module "<name>"`. */
export function ambientModule(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent)
    if (ts.isModuleDeclaration(n) && ts.isStringLiteral(n.name)) return n.name.text;
  return undefined;
}

const NODE_MODULES = '/node_modules/';

/**
 * The npm package a declaration file belongs to: from its last `node_modules` segment, otherwise
 * the nearest package.json with a name (a linked workspace package). Cached per directory.
 */
export class PackageResolver {
  private readonly byDir = new Map<string, string | null>();

  packageOf(fileName: string): string | undefined {
    const file = fileName.replace(/\\/g, '/');
    const at = file.lastIndexOf(NODE_MODULES);
    if (at >= 0) return packageName(file.slice(at + NODE_MODULES.length));
    return this.nearest(dirname(file)) ?? undefined;
  }

  private nearest(dir: string): string | null {
    const cached = this.byDir.get(dir);
    if (cached !== undefined) return cached;
    let found: string | null = null;
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
        if (typeof json.name === 'string') found = json.name;
      } catch {
        found = null;
      }
    }
    if (found === null && dirname(dir) !== dir) found = this.nearest(dirname(dir));
    this.byDir.set(dir, found);
    return found;
  }
}

/**
 * The descriptor entry for a member declared in `pkg`: the package must be one of the
 * descriptor's `declaredIn` and the member and container must match an entry. Descriptors are
 * tried in the order given, so the caller puts the SDKs the source imports first.
 */
export function matchMember(
  descriptors: readonly Descriptor[],
  pkg: string,
  key: MemberKey,
): DescriptorMatch | undefined {
  for (const descriptor of descriptors) {
    if (!descriptor.declaredIn.includes(pkg)) continue;
    for (const entry of descriptor.calls) {
      if (isHook(entry) || entry.member !== key.member || !entry.on.includes(key.container))
        continue;
      return { descriptor, entry, declaration: `${key.container}.${key.member}` };
    }
  }
  return undefined;
}

/** Member names a descriptor describes (hooks only return the client), for unresolved calls. */
export function memberNames(descriptor: Descriptor): Set<string> {
  return new Set(descriptor.calls.flatMap((c) => (isHook(c) ? [] : [c.member])));
}
