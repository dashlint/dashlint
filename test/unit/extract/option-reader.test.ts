import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { OptionReader, optionsArgument, type OptionValue } from '../../../src/extract/index.js';

const FILE = '/virtual/a.ts';

/** Reads `export const target = <expr>;` in a one-file program, at `path`. */
function readIn(prelude: string, expr: string, path: string[] = []): OptionValue {
  const text = `${prelude}\nexport const target = ${expr};\n`;
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    name === FILE ? ts.createSourceFile(name, text, lang, true) : original(name, lang, ...rest);
  host.fileExists = (name) => name === FILE || ts.sys.fileExists(name);
  const program = ts.createProgram([FILE], { strict: true, target: ts.ScriptTarget.ES2022 }, host);
  const sf = program.getSourceFile(FILE);
  if (!sf) throw new Error('no source');
  let node: ts.Expression | undefined;
  ts.forEachChild(sf, function visit(n) {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'target') node = n.initializer;
    ts.forEachChild(n, visit);
  });
  if (!node) throw new Error('no target');
  return new OptionReader(program.getTypeChecker()).read(node, path);
}

const val = (value: string | number | boolean | null): OptionValue => ({ kind: 'value', value });
const absent: OptionValue = { kind: 'absent' };
const object: OptionValue = { kind: 'object' };
const unknown = (reason: string): OptionValue => ({ kind: 'unknown', reason });

describe('OptionReader: literals and types', () => {
  it('reads literal expressions', () => {
    expect(readIn('', 'true')).toEqual(val(true));
    expect(readIn('', 'false')).toEqual(val(false));
    expect(readIn('', 'null')).toEqual(val(null));
    expect(readIn('', "'x'")).toEqual(val('x'));
    expect(readIn('', '`tpl`')).toEqual(val('tpl'));
    expect(readIn('', '42')).toEqual(val(42));
    expect(readIn('', 'undefined')).toEqual(absent);
    expect(readIn('', '[1]')).toEqual(object);
    expect(readIn('', '() => 1')).toEqual(object);
    expect(readIn('', 'function () { return 1; }')).toEqual(object);
    expect(readIn('', '{}')).toEqual(object);
  });

  it('looks through parentheses and assertions', () => {
    expect(readIn('', '({ a: true }) as object', ['a'])).toEqual(val(true));
    expect(readIn('', '(false)')).toEqual(val(false));
  });

  it('a non-literal expression falls back to its type', () => {
    expect(readIn('declare function f(): "a";', 'f()')).toEqual(val('a'));
    expect(readIn('declare function f(): string;', 'f()')).toEqual(
      unknown('the option has type `string`'),
    );
  });

  it('an identifier without an initializer is read by its type', () => {
    expect(readIn('declare const v: undefined;', 'v')).toEqual(absent);
    expect(readIn('declare const v: void;', 'v')).toEqual(absent);
    expect(readIn('declare const v: "s";', 'v')).toEqual(val('s'));
    expect(readIn('declare const v: 7;', 'v')).toEqual(val(7));
    expect(readIn('declare const v: true;', 'v')).toEqual(val(true));
    expect(readIn('declare const v: false;', 'v')).toEqual(val(false));
    expect(readIn('declare const v: null;', 'v')).toEqual(val(null));
    expect(readIn('declare const v: boolean;', 'v')).toEqual(
      unknown('the option has type `boolean`'),
    );
    expect(readIn('declare const v: string | number;', 'v')).toEqual(
      unknown('the option has type `string | number`'),
    );
  });

  it('a path into a non-literal identifier is unknown with its name', () => {
    expect(readIn('declare const v: Record<string, boolean>;', 'v', ['a'])).toEqual(
      unknown('the options are `v`, not an object literal'),
    );
    expect(readIn('let v = { a: true };', 'v', ['a'])).toEqual(
      unknown('the options are `v`, not an object literal'),
    );
  });

  it('a path into a non-object expression is unknown', () => {
    expect(readIn('', "'text'", ['a'])).toEqual(unknown('the options are not an object literal'));
    expect(readIn('', '[1]', ['a'])).toEqual(unknown('the options are not an object literal'));
  });
});

describe('OptionReader: const aliases', () => {
  it('follows a const, and an imported-style chain up to eight steps', () => {
    const chain = (n: number) =>
      ['const c0 = { k: true };', ...Array.from({ length: n }, (_, i) => `const c${i + 1} = c${i};`)]
        .join('\n');
    expect(readIn(chain(7), 'c7', ['k'])).toEqual(val(true));
    expect(readIn(chain(8), 'c8', ['k'])).toEqual(
      unknown('the options are `c0`, not an object literal'),
    );
  });

  it('follows a const to a literal at the end of a path', () => {
    expect(readIn('const on = true;', '{ flag: on }', ['flag'])).toEqual(val(true));
  });

  it('does not follow let or var, or a const without an initializer', () => {
    expect(readIn('let a: true = true;', 'a')).toEqual(val(true));
    expect(readIn('var a = { k: 1 };', 'a', ['k'])).toEqual(
      unknown('the options are `a`, not an object literal'),
    );
  });
});

describe('OptionReader: object literals', () => {
  it('reads present and absent keys, nested paths, quoted and numeric keys', () => {
    expect(readIn('', '{ a: 1 }', ['a'])).toEqual(val(1));
    expect(readIn('', '{ a: 1 }', ['b'])).toEqual(absent);
    expect(readIn('', '{ a: { b: false } }', ['a', 'b'])).toEqual(val(false));
    expect(readIn('', '{ a: { b: false } }', ['a'])).toEqual(object);
    expect(readIn('', '{ a: { b: false } }', ['a', 'c'])).toEqual(absent);
    expect(readIn('', "{ 'q-r': 2 }", ['q-r'])).toEqual(val(2));
    expect(readIn('', '{ 7: true }', ['7'])).toEqual(val(true));
    expect(readIn('declare const k: string;', '{ [k]: 1 }', ['k'])).toEqual(absent);
  });

  it('the last write of a key wins', () => {
    expect(readIn('', '{ a: 1, a: 2 }', ['a'])).toEqual(val(2));
  });

  it('a spread after the key may override it; one before does not', () => {
    expect(readIn('declare const s: object;', '{ a: 1, ...s }', ['a'])).toEqual(
      unknown('a spread in the options may set `a`'),
    );
    expect(readIn('declare const s: object;', '{ ...s, a: 1 }', ['a'])).toEqual(val(1));
    expect(readIn('declare const s: object;', '{ ...s }', [])).toEqual(object);
  });

  it('a shorthand property is read through its identifier', () => {
    expect(readIn('declare const a: false;', '{ a }', ['a'])).toEqual(val(false));
    expect(readIn('declare const a: undefined;', '{ a }', ['a'])).toEqual(absent);
    expect(readIn('const a = { z: 5 };', '{ a }', ['a', 'z'])).toEqual(
      unknown('the options are `a`, not an object literal'),
    );
    expect(readIn('declare const a: string;', '{ a }', ['a'])).toEqual(
      unknown('the option has type `string`'),
    );
  });

  it('a method is a truthy function; an accessor is unknown', () => {
    expect(readIn('', '{ m() { return 1; } }', ['m'])).toEqual(object);
    expect(readIn('', '{ m() { return 1; } }', ['m', 'x'])).toEqual(unknown('`m` is an accessor'));
    expect(readIn('', '{ get g() { return 1; } }', ['g'])).toEqual(unknown('`g` is an accessor'));
    expect(readIn('', '{ set g(v: number) {} }', ['g'])).toEqual(unknown('`g` is an accessor'));
  });
});

describe('optionsArgument', () => {
  const args = (code: string): readonly ts.Expression[] => {
    const sf = ts.createSourceFile('x.ts', `f(${code});`, ts.ScriptTarget.ES2022, true);
    const stmt = sf.statements[0] as ts.ExpressionStatement;
    return (stmt.expression as ts.CallExpression).arguments;
  };
  const text = (o: ReturnType<typeof optionsArgument>): string =>
    o.kind === 'expression' ? o.node.getText() : o.kind === 'unknown' ? o.reason : o.kind;

  it('no arguments, or the position not passed, keeps every default', () => {
    expect(optionsArgument(undefined, 'args[1]')).toEqual({ kind: 'none' });
    expect(optionsArgument(args('a'), 'args[1]')).toEqual({ kind: 'none' });
  });

  it('takes the argument at the position', () => {
    expect(text(optionsArgument(args('a, b, c'), 'args[1]'))).toBe('b');
    expect(text(optionsArgument(args('a, b, c'), 'args[0]'))).toBe('a');
  });

  it('given several positions, the last one passed holds the options', () => {
    expect(text(optionsArgument(args('a, b'), ['args[1]', 'args[2]']))).toBe('b');
    expect(text(optionsArgument(args('a, b, c'), ['args[2]', 'args[1]']))).toBe('c');
    expect(text(optionsArgument(args('a, b, c'), ['args[1]', 'args[2]']))).toBe('c');
  });

  it('a spread at or before the options position hides it', () => {
    const reason = 'the options are in a spread argument';
    expect(text(optionsArgument(args('...r, b'), 'args[1]'))).toBe(reason);
    expect(text(optionsArgument(args('a, ...r'), 'args[1]'))).toBe(reason);
    expect(text(optionsArgument(args('...r'), 'args[0]'))).toBe(reason);
  });

  it('a spread after the options position does not', () => {
    expect(text(optionsArgument(args('a, b, ...r'), 'args[1]'))).toBe('b');
    expect(text(optionsArgument(args('a, ...r'), 'args[0]'))).toBe('a');
  });
});
