// T10.2: identityContext rule by rule (ADR-027), on parsed code only. The marker call is
// `reset()`; each snippet has exactly one.
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { identityContext } from '../../../src/extract/index.js';

function contextOf(code: string, tsx = false): string {
  const sf = ts.createSourceFile(
    tsx ? 'a.tsx' : 'a.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'reset')
      found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(found, code).toHaveLength(1);
  return identityContext(found[0] as ts.CallExpression);
}

describe('identityContext (ADR-027)', () => {
  it('module-init: at module level, or in a function with no body', () => {
    expect(contextOf('reset();')).toBe('module-init');
    expect(contextOf('declare function boot(a?: unknown): void; boot(reset());')).toBe(
      'module-init',
    );
    expect(contextOf('declare function boot(a: unknown = reset()): void;')).toBe('module-init');
  });

  it('an anonymous callback is looked through: at module level it is other', () => {
    expect(contextOf('later.then(() => { reset(); });')).toBe('other');
    expect(contextOf('setTimeout(function () { reset(); }, 10);')).toBe('other');
  });

  it('mount-effect: an effect with an empty dependency list, also called as React.useEffect', () => {
    expect(contextOf('useEffect(() => { reset(); }, []);')).toBe('mount-effect');
    expect(contextOf('React.useLayoutEffect(() => { reset(); }, []);')).toBe('mount-effect');
    expect(contextOf('function Shelf() { useEffect(() => { reset(); }, []); }')).toBe(
      'mount-effect',
    );
  });

  it('other: an effect with dependencies, none, or not an array; the callback not first', () => {
    expect(contextOf('useEffect(() => { reset(); }, [shelf]);')).toBe('other');
    expect(contextOf('useEffect(() => { reset(); });')).toBe('other');
    expect(contextOf('useEffect(() => { reset(); }, deps);')).toBe('other');
    expect(contextOf('useEffect(setup, () => { reset(); });')).toBe('other');
    expect(contextOf("hooks['useEffect'](() => { reset(); }, []);")).toBe('other');
    expect(contextOf('runOnce(() => { reset(); }, []);')).toBe('other');
  });

  it('handler: an addEventListener callback', () => {
    expect(contextOf("window.addEventListener('blur', () => { reset(); });")).toBe('handler');
  });

  it('handler only for an on* JSX prop', () => {
    expect(contextOf('const b = <button onClick={() => { reset(); }} />;', true)).toBe('handler');
    expect(contextOf('const b = <Shelf render={() => { reset(); }} />;', true)).toBe('other');
    expect(contextOf('const b = <Shelf reasonOnly={() => { reset(); }} />;', true)).toBe('other');
    expect(contextOf('const b = <Shelf once={() => { reset(); }} />;', true)).toBe('other');
  });

  it('mount-effect: componentDidMount as a method only', () => {
    expect(contextOf('class Shelf { componentDidMount() { reset(); } }')).toBe('mount-effect');
    expect(contextOf('class Shelf { componentWillUnmount() { reset(); } }')).toBe('other');
    expect(contextOf('function componentDidMount() { reset(); }')).toBe('other');
  });

  it('handler: a name that handles something, from the function, its variable or its key', () => {
    expect(contextOf('function handleLogout() { reset(); }')).toBe('handler');
    expect(contextOf('const signOut = () => { reset(); };')).toBe('handler');
    expect(contextOf("const actions = { 'onPress': () => { reset(); } };")).toBe('handler');
    expect(contextOf('class Shelf { logout = () => { reset(); }; }')).toBe('handler');
    expect(contextOf('function helper() { reset(); }')).toBe('other');
  });

  it('private and computed names are no names', () => {
    expect(contextOf('class Shelf { #logout() { reset(); } }')).toBe('other');
    expect(contextOf('class Shelf { #logout = () => { reset(); }; }')).toBe('other');
    expect(contextOf("class Shelf { ['logout']() { reset(); } }")).toBe('other');
  });

  it('a named callback decides by its own name; the innermost deciding function wins', () => {
    expect(contextOf('later.then(function handleDone() { reset(); });')).toBe('handler');
    expect(contextOf('function handleTap() { function helper() { reset(); } }')).toBe('other');
    expect(contextOf('function helper() { later.then(() => { reset(); }); }')).toBe('other');
    expect(contextOf('function onTap() { later.then(() => { reset(); }); }')).toBe('handler');
  });
});
