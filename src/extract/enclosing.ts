// The function around a call site, for the rename heuristic of `diff` (spec 6.7.5): an event removed
// and one added with sites in the same enclosing function are "renamed". Lines move between commits,
// so a function is named by its containers (`Shelf.share`), never by its position.
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import ts from 'typescript';

const ANONYMOUS = '(anonymous)';

function scriptKind(fileName: string): ts.ScriptKind {
  switch (extname(fileName).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function nameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** A function-like node's name, or undefined when the node is not a function or class. */
function segment(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
    return node.name?.text ?? nameText(holder(node)) ?? ANONYMOUS;
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
    return nameText(node.name) ?? ANONYMOUS;
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node))
    return (
      (ts.isFunctionExpression(node) ? node.name?.text : undefined) ??
      nameText(holder(node)) ??
      ANONYMOUS
    );
  return undefined;
}

/** The name a function or class expression is stored under (`const share = () => ...`). */
function holder(node: ts.Node): ts.PropertyName | ts.BindingName | undefined {
  const p = node.parent;
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))
    return p.name;
  return undefined;
}

/**
 * The function around the first token of a 1-based line, named by its containers (`Shelf.share`,
 * `useShelf.(anonymous)`); null at module top level or past the end of the file.
 */
export function enclosingFunction(text: string, fileName: string, line: number): string | null {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  return enclosingIn(sf, line);
}

function enclosingIn(sf: ts.SourceFile, line: number): string | null {
  const starts = sf.getLineStarts();
  if (line < 1 || line > starts.length) return null;
  const lineStart = starts[line - 1] as number;
  const lineEnd = line < starts.length ? (starts[line] as number) : sf.text.length;
  const text = sf.text.slice(lineStart, lineEnd);
  const offset = text.search(/\S/);
  if (offset < 0) return null;
  const lo = lineStart + offset;
  const hi = lineStart + text.trimEnd().length;

  // Sites carry a line, not a column: the deepest function overlapping the line's text wins, so
  // `onClick={() => capture(...)}` on one line is inside the arrow function.
  let best: readonly string[] | null = null;
  let bestDepth = 0;
  const visit = (node: ts.Node, chain: readonly string[], depth: number): void => {
    if (node.getStart(sf) >= hi || node.end <= lo) return;
    const s = segment(node);
    let next = chain;
    let d = depth;
    if (s !== undefined) {
      next = [...chain, s];
      if (!ts.isClassDeclaration(node) && !ts.isClassExpression(node)) {
        d = depth + 1;
        if (d > bestDepth) {
          best = next;
          bestDepth = d;
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, next, d));
  };
  ts.forEachChild(sf, (c) => visit(c, [], 0));
  return best === null ? null : (best as readonly string[]).join('.');
}

/**
 * `(file, line) => function` for the files under `root` (repository-relative paths, as catalog
 * sites give them). Each file is read and parsed once; an unreadable file gives null.
 */
export function enclosingFunctions(root: string): (file: string, line: number) => string | null {
  const parsed = new Map<string, ts.SourceFile | null>();
  return (file, line) => {
    let sf = parsed.get(file);
    if (sf === undefined) {
      try {
        const text = readFileSync(join(root, file), 'utf8');
        sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
      } catch {
        sf = null;
      }
      parsed.set(file, sf);
    }
    return sf === null ? null : enclosingIn(sf, line);
  };
}
