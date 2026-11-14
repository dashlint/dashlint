// Reads what a descriptor's type stub declares, from its syntax only (no program, no checker): the
// ambient modules, the classes and interfaces with their members, and module-level functions. The
// loader uses it to refuse a descriptor whose members the stub does not declare (T3.1).
import ts from 'typescript';
import { MODULE_CONTAINER, type StubSurface } from './model.js';

function memberName(m: ts.ClassElement | ts.TypeElement): string | undefined {
  const name = m.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

// Members of a class or interface (or an object type), and each object-typed property as a nested
// container `Container.property`.
function addContainer(
  surface: StubSurface,
  container: string,
  members: readonly (ts.ClassElement | ts.TypeElement)[],
): void {
  const names = surface.containers.get(container) ?? new Set<string>();
  surface.containers.set(container, names);
  for (const m of members) {
    // A constructor is listed as `constructor`, which an init entry may name.
    const name = ts.isConstructorDeclaration(m) ? 'constructor' : memberName(m);
    if (name === undefined) continue;
    const modifiers = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
    if (modifiers?.some((k) => k.kind === ts.SyntaxKind.PrivateKeyword)) continue;
    names.add(name);
    const type = ts.isPropertyDeclaration(m) || ts.isPropertySignature(m) ? m.type : undefined;
    if (type && ts.isTypeLiteralNode(type))
      addContainer(surface, `${container}.${name}`, type.members);
  }
}

function addStatements(surface: StubSurface, statements: readonly ts.Statement[]): void {
  for (const s of statements) {
    if ((ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name) {
      addContainer(surface, s.name.text, s.members);
    } else if (ts.isFunctionDeclaration(s) && s.name) {
      // A module-level function is a hook, or a member of the `(module)` container (ADR-054).
      surface.functions.add(s.name.text);
      const fns = surface.containers.get(MODULE_CONTAINER) ?? new Set<string>();
      surface.containers.set(MODULE_CONTAINER, fns.add(s.name.text));
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations)
        if (ts.isIdentifier(d.name)) surface.functions.add(d.name.text);
    }
  }
}

export function readStubSurface(source: string, fileName: string): StubSurface {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const surface: StubSurface = { modules: [], containers: new Map(), functions: new Set() };
  for (const s of sf.statements) {
    if (ts.isModuleDeclaration(s) && ts.isStringLiteral(s.name)) {
      surface.modules.push(s.name.text);
      if (s.body && ts.isModuleBlock(s.body)) addStatements(surface, s.body.statements);
    }
  }
  return surface;
}
