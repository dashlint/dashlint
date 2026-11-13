// The formula evaluator (spec 6.7.3): a tile formula such as `A/B*100` over series letters. The
// grammar is letters, numbers, `+ - * /`, parentheses and unary minus; anything else leaves the
// formula unknown. The verdict comes from evaluating the expression with dead series at 0 and live
// series at fixed positive values, then with the dead series positive too (ADR-040).
import type { PartEffect } from './checks/types.js';

export type FormulaAst =
  | { kind: 'ref'; ref: string }
  | { kind: 'num'; value: number }
  | { kind: 'neg'; arg: FormulaAst }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: FormulaAst; right: FormulaAst };

export type ParseResult = { ok: true; ast: FormulaAst } | { ok: false; reason: string };

/** A formula the grammar does not cover. */
export const FORMULA_NOT_PARSED = 'formula-not-parsed';
/** A formula letter no series of the tile carries. */
export const FORMULA_UNKNOWN_SERIES = 'formula-unknown-series';
/** A formula over a series that is not checked, and not dead whatever that series holds. */
export const FORMULA_SERIES_UNKNOWN = 'formula-series-unknown';

type Token =
  | { t: 'ref'; ref: string }
  | { t: 'num'; value: number }
  | { t: 'op'; op: '+' | '-' | '*' | '/' }
  | { t: '(' }
  | { t: ')' };

function tokenize(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  const re = /\s+|([A-Za-z]+)|(\d+(?:\.\d+)?|\.\d+)|([-+*/()])/y;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (m === null) return undefined;
    at = re.lastIndex;
    const [, letters, number, symbol] = m;
    if (letters !== undefined) {
      // One letter per series; a longer word is a function name, not in the grammar.
      if (letters.length !== 1) return undefined;
      tokens.push({ t: 'ref', ref: letters.toUpperCase() });
    } else if (number !== undefined) tokens.push({ t: 'num', value: Number(number) });
    else if (symbol === '(' || symbol === ')') tokens.push({ t: symbol });
    else if (symbol !== undefined) tokens.push({ t: 'op', op: symbol as '+' | '-' | '*' | '/' });
  }
  return tokens;
}

/** Parses a formula; precedence as arithmetic, left associative, unary minus binds tightest. */
export function parseFormula(text: string): ParseResult {
  const tokens = tokenize(text);
  if (tokens === undefined || tokens.length === 0) return { ok: false, reason: FORMULA_NOT_PARSED };
  let i = 0;
  const peek = (): Token | undefined => tokens[i];
  const isOp = (tok: Token | undefined, ...ops: string[]): boolean =>
    tok !== undefined && tok.t === 'op' && ops.includes(tok.op);

  function primary(): FormulaAst | undefined {
    const tok = peek();
    if (tok === undefined) return undefined;
    i++;
    if (tok.t === 'ref') return { kind: 'ref', ref: tok.ref };
    if (tok.t === 'num') return { kind: 'num', value: tok.value };
    if (tok.t === 'op' && tok.op === '-') {
      const arg = primary();
      return arg === undefined ? undefined : { kind: 'neg', arg };
    }
    if (tok.t === '(') {
      const inner = sum();
      if (inner === undefined || peek()?.t !== ')') return undefined;
      i++;
      return inner;
    }
    return undefined;
  }

  function product(): FormulaAst | undefined {
    let left = primary();
    while (left !== undefined && isOp(peek(), '*', '/')) {
      const op = (peek() as { op: '*' | '/' }).op;
      i++;
      const right = primary();
      left = right === undefined ? undefined : { kind: 'bin', op, left, right };
    }
    return left;
  }

  function sum(): FormulaAst | undefined {
    let left = product();
    while (left !== undefined && isOp(peek(), '+', '-')) {
      const op = (peek() as { op: '+' | '-' }).op;
      i++;
      const right = product();
      left = right === undefined ? undefined : { kind: 'bin', op, left, right };
    }
    return left;
  }

  const ast = sum();
  if (ast === undefined || i !== tokens.length) return { ok: false, reason: FORMULA_NOT_PARSED };
  return { ok: true, ast };
}

/** The series letters an expression uses, sorted. */
export function formulaRefs(ast: FormulaAst): string[] {
  const out = new Set<string>();
  const walk = (n: FormulaAst): void => {
    if (n.kind === 'ref') out.add(n.ref);
    else if (n.kind === 'neg') walk(n.arg);
    else if (n.kind === 'bin') {
      walk(n.left);
      walk(n.right);
    }
  };
  walk(ast);
  return [...out].sort();
}

/** Plain IEEE arithmetic: division by zero gives an infinity or NaN, as PostHog's does. */
export function evaluateFormula(ast: FormulaAst, values: (ref: string) => number): number {
  switch (ast.kind) {
    case 'ref':
      return values(ast.ref);
    case 'num':
      return ast.value;
    case 'neg':
      return -evaluateFormula(ast.arg, values);
    case 'bin': {
      const l = evaluateFormula(ast.left, values);
      const r = evaluateFormula(ast.right, values);
      if (ast.op === '+') return l + r;
      if (ast.op === '-') return l - r;
      if (ast.op === '*') return l * r;
      return l / r;
    }
  }
}

/** Two fixed positive values per letter, chosen so that unrelated series do not cancel. */
function fixedValue(ref: string, run: 0 | 1): number {
  const n = ref.charCodeAt(0) - 64;
  return run === 0 ? Math.sqrt(2 + 3 * n) : Math.log(10 + 7 * n);
}

/** Equal up to rounding; NaN equals NaN and an infinity only itself. */
export function sameResult(a: number, b: number): boolean {
  if (Object.is(a, b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

const useless = (v: number): boolean => v === 0 || !Number.isFinite(v);

export type FormulaEffect = PartEffect | 'partly-dead';

export interface FormulaVerdict {
  effect: FormulaEffect;
  /** Unknown only: the reasons, sorted. */
  reasons?: string[];
}

/**
 * The formula's verdict from its series' effects (by letter). Dead: with every dead series at 0 the
 * result is 0 or not finite in both evaluations (unknown series at their positive values); partly dead:
 * the result changes when the dead series are positive; an unknown series makes it unknown unless
 * it is already dead; a degraded series makes an otherwise live formula degraded. With no dead
 * series the arithmetic alone never makes a formula dead (T1: dead only from a definite no).
 */
export function formulaVerdict(
  text: string,
  series: ReadonlyMap<string, PartEffect>,
): FormulaVerdict {
  const parsed = parseFormula(text);
  if (!parsed.ok) return { effect: 'unknown', reasons: [parsed.reason] };
  const refs = formulaRefs(parsed.ast);
  if (refs.some((r) => !series.has(r)))
    return { effect: 'unknown', reasons: [FORMULA_UNKNOWN_SERIES] };
  const effect = (r: string): PartEffect => series.get(r) as PartEffect;
  const dead = refs.filter((r) => effect(r) === 'dead');
  const unknown = refs.filter((r) => effect(r) === 'unknown');
  // The four evaluations: two sets of fixed values, each with the dead series at 0 and positive.
  const run = (r0: 0 | 1, deadZero: boolean): number =>
    evaluateFormula(parsed.ast, (r) => (deadZero && effect(r) === 'dead' ? 0 : fixedValue(r, r0)));
  if (dead.length > 0 && useless(run(0, true)) && useless(run(1, true))) return { effect: 'dead' };
  if (unknown.length > 0) return { effect: 'unknown', reasons: [FORMULA_SERIES_UNKNOWN] };
  const changes = (r0: 0 | 1): boolean => !sameResult(run(r0, true), run(r0, false));
  if (dead.length > 0 && (changes(0) || changes(1))) return { effect: 'partly-dead' };
  return { effect: refs.some((r) => effect(r) === 'degraded') ? 'degraded' : 'live' };
}
