import { describe, expect, it } from 'vitest';
import {
  FORMULA_NOT_PARSED,
  FORMULA_SERIES_UNKNOWN,
  FORMULA_UNKNOWN_SERIES,
  evaluateFormula,
  formulaRefs,
  formulaVerdict,
  parseFormula,
  sameResult,
  type FormulaAst,
  type PartEffect,
} from '../../../src/check/index.js';

const effects = (pairs: Record<string, PartEffect>) => new Map(Object.entries(pairs));

function ast(text: string): FormulaAst {
  const r = parseFormula(text);
  if (!r.ok) throw new Error(`not parsed: ${text}`);
  return r.ast;
}

describe('formula grammar (spec 6.7.3)', () => {
  it('parses letters, numbers, + - * /, parentheses and unary minus', () => {
    expect(ast('A/B*100')).toEqual({
      kind: 'bin',
      op: '*',
      left: {
        kind: 'bin',
        op: '/',
        left: { kind: 'ref', ref: 'A' },
        right: { kind: 'ref', ref: 'B' },
      },
      right: { kind: 'num', value: 100 },
    });
    expect(ast('a + b')).toEqual(ast('A+B'));
    expect(ast('-(A - 2.5) * .5')).toEqual({
      kind: 'bin',
      op: '*',
      left: {
        kind: 'neg',
        arg: {
          kind: 'bin',
          op: '-',
          left: { kind: 'ref', ref: 'A' },
          right: { kind: 'num', value: 2.5 },
        },
      },
      right: { kind: 'num', value: 0.5 },
    });
    expect(ast('A*-B')).toEqual({
      kind: 'bin',
      op: '*',
      left: { kind: 'ref', ref: 'A' },
      right: { kind: 'neg', arg: { kind: 'ref', ref: 'B' } },
    });
    expect(ast('--A')).toEqual({
      kind: 'neg',
      arg: { kind: 'neg', arg: { kind: 'ref', ref: 'A' } },
    });
  });

  it('is left associative with * and / above + and -', () => {
    const v = (text: string) => evaluateFormula(ast(text), (r) => ({ A: 8, B: 4, C: 2 })[r] ?? 0);
    expect(v('A-B-C')).toBe(2);
    expect(v('A/B/C')).toBe(1);
    expect(v('A-B*C')).toBe(0);
    expect(v('(A-B)*C')).toBe(8);
    expect(v('A/B*C')).toBe(4);
  });

  it('anything else leaves the formula unknown', () => {
    for (const text of [
      '',
      '   ',
      'A^2',
      'A%B',
      '+A',
      'A++B',
      'A*',
      '-',
      'A-',
      'A*-',
      '(A',
      'A)',
      '()',
      'AB',
      'sum(A)',
      'A B',
      '1e3',
      'A,B',
      '2.',
      'A = B',
      'Ä',
    ])
      expect(parseFormula(text), text).toEqual({ ok: false, reason: FORMULA_NOT_PARSED });
  });

  it('lists the letters used, sorted', () => {
    expect(formulaRefs(ast('C/(A+c)-B*2'))).toEqual(['A', 'B', 'C']);
    expect(formulaRefs(ast('100'))).toEqual([]);
  });

  it('division by zero is IEEE', () => {
    expect(evaluateFormula(ast('A/B'), (r) => (r === 'A' ? 1 : 0))).toBe(Infinity);
    expect(evaluateFormula(ast('A/B'), () => 0)).toBeNaN();
  });

  it('results compare equal up to rounding; NaN equals NaN, an infinity only itself', () => {
    expect(sameResult(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameResult(0, -0)).toBe(true);
    expect(sameResult(1e12, 1e12 + 1e-3)).toBe(true);
    expect(sameResult(1, 1.001)).toBe(false);
    expect(sameResult(NaN, NaN)).toBe(true);
    expect(sameResult(NaN, 1)).toBe(false);
    expect(sameResult(1, NaN)).toBe(false);
    expect(sameResult(Infinity, Infinity)).toBe(true);
    expect(sameResult(Infinity, -Infinity)).toBe(false);
    expect(sameResult(Infinity, 1e300)).toBe(false);
    expect(sameResult(1e300, -Infinity)).toBe(false);
    expect(sameResult(Infinity, NaN)).toBe(false);
  });
});

describe('formula verdict (spec 6.7.3)', () => {
  it('negative control: A/B with dead B is dead (never finite)', () => {
    expect(formulaVerdict('A/B', effects({ A: 'live', B: 'dead' }))).toEqual({ effect: 'dead' });
  });

  it('negative control: A+B with dead B is partly dead', () => {
    expect(formulaVerdict('A+B', effects({ A: 'live', B: 'dead' }))).toEqual({
      effect: 'partly-dead',
    });
  });

  it('always zero is dead', () => {
    expect(formulaVerdict('A*B', effects({ A: 'live', B: 'dead' })).effect).toBe('dead');
    expect(formulaVerdict('B/A', effects({ A: 'live', B: 'dead' })).effect).toBe('dead');
    expect(formulaVerdict('B', effects({ B: 'dead' })).effect).toBe('dead');
    expect(formulaVerdict('A*B+B', effects({ A: 'live', B: 'dead' })).effect).toBe('dead');
  });

  it('a result that does not change with the dead series is live', () => {
    expect(formulaVerdict('A+0*B', effects({ A: 'live', B: 'dead' })).effect).toBe('live');
    expect(formulaVerdict('A+B-B', effects({ A: 'live', B: 'dead' })).effect).toBe('live');
  });

  it('different live series never cancel: (A-B)+C with dead C is partly dead', () => {
    expect(formulaVerdict('(A-B)+C', effects({ A: 'live', B: 'live', C: 'dead' })).effect).toBe(
      'partly-dead',
    );
    expect(formulaVerdict('C/(A-B)', effects({ A: 'live', B: 'live', C: 'dead' })).effect).toBe(
      'dead',
    );
  });

  it('a constant or the live series alone is never dead (T1)', () => {
    expect(formulaVerdict('A-A', effects({ A: 'live' })).effect).toBe('live');
    expect(formulaVerdict('0', effects({})).effect).toBe('live');
    expect(formulaVerdict('A/(A-A)', effects({ A: 'live' })).effect).toBe('live');
  });

  it('every series dead: dead', () => {
    expect(formulaVerdict('A+B', effects({ A: 'dead', B: 'dead' })).effect).toBe('dead');
    expect(formulaVerdict('A/B', effects({ A: 'dead', B: 'dead' })).effect).toBe('dead');
  });

  it('an unknown series makes it unknown unless it is already dead', () => {
    expect(formulaVerdict('A+B', effects({ A: 'unknown', B: 'live' }))).toEqual({
      effect: 'unknown',
      reasons: [FORMULA_SERIES_UNKNOWN],
    });
    expect(formulaVerdict('A+B', effects({ A: 'unknown', B: 'dead' })).effect).toBe('unknown');
    expect(formulaVerdict('A*B', effects({ A: 'unknown', B: 'dead' })).effect).toBe('dead');
    expect(formulaVerdict('A/B', effects({ A: 'unknown', B: 'dead' })).effect).toBe('dead');
    // B - A is 0 only when A is: not dead whatever A holds
    expect(formulaVerdict('B-A', effects({ A: 'unknown', B: 'dead' })).effect).toBe('unknown');
  });

  it('a degraded series makes an otherwise live formula degraded', () => {
    expect(formulaVerdict('A+B', effects({ A: 'degraded', B: 'live' })).effect).toBe('degraded');
    expect(formulaVerdict('A+B', effects({ A: 'degraded', B: 'dead' })).effect).toBe('partly-dead');
    expect(formulaVerdict('A*B', effects({ A: 'degraded', B: 'dead' })).effect).toBe('dead');
  });

  it('a letter no series carries, or a formula outside the grammar, is unknown', () => {
    expect(formulaVerdict('A+C', effects({ A: 'live', B: 'live' }))).toEqual({
      effect: 'unknown',
      reasons: [FORMULA_UNKNOWN_SERIES],
    });
    expect(formulaVerdict('A^2', effects({ A: 'dead' }))).toEqual({
      effect: 'unknown',
      reasons: [FORMULA_NOT_PARSED],
    });
  });
});

// Property tests: a seeded generator, 1,000 random expressions per property (T6.4 acceptance).
const RUNS = 1000;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gen(rand: () => number, letters: readonly string[], depth: number): FormulaAst {
  const pick = rand();
  if (depth <= 0 || pick < 0.3) {
    if (rand() < 0.75)
      return { kind: 'ref', ref: letters[Math.floor(rand() * letters.length)] as string };
    const value = rand() < 0.5 ? 1 + Math.floor(rand() * 9) : Math.floor(rand() * 1000) / 100;
    return { kind: 'num', value };
  }
  if (pick < 0.4) return { kind: 'neg', arg: gen(rand, letters, depth - 1) };
  const op = (['+', '-', '*', '/'] as const)[Math.floor(rand() * 4)] as '+' | '-' | '*' | '/';
  return {
    kind: 'bin',
    op,
    left: gen(rand, letters, depth - 1),
    right: gen(rand, letters, depth - 1),
  };
}

const prec = (n: FormulaAst): number =>
  n.kind === 'bin' ? (n.op === '+' || n.op === '-' ? 1 : 2) : 3;

/** Prints with the fewest parentheses the grammar needs, and random spaces. */
function print(n: FormulaAst, rand: () => number): string {
  const sp = () => (rand() < 0.3 ? ' ' : '');
  if (n.kind === 'ref') return rand() < 0.2 ? n.ref.toLowerCase() : n.ref;
  if (n.kind === 'num') return String(n.value);
  if (n.kind === 'neg') {
    const inner = print(n.arg, rand);
    return n.arg.kind === 'bin' ? `-(${inner})` : `-${inner}`;
  }
  const l = print(n.left, rand);
  const r = print(n.right, rand);
  const left = prec(n.left) < prec(n) ? `(${l})` : l;
  const right = prec(n.right) <= prec(n) ? `(${r})` : r;
  return `${left}${sp()}${n.op}${sp()}${right}`;
}

const LIVE = ['A', 'B', 'C', 'D'];

describe('formula property tests (1,000 random expressions each)', () => {
  it('printing then parsing gives the same tree (precedence and associativity)', () => {
    const rand = rng(1);
    for (let i = 0; i < RUNS; i++) {
      const tree = gen(rand, LIVE, 5);
      const text = print(tree, rand);
      const parsed = parseFormula(text);
      expect(parsed, text).toEqual({ ok: true, ast: tree });
    }
  });

  it('one character outside the grammar makes any expression unknown', () => {
    const rand = rng(2);
    const bad = ['^', '%', ',', '=', '$', '!', '&', '[', 'AB', '+'];
    for (let i = 0; i < RUNS; i++) {
      const text = print(gen(rand, LIVE, 4), rand);
      const at = Math.floor(rand() * (text.length + 1));
      const b = bad[i % bad.length] as string;
      // A plus is only outside the grammar as a unary operator: put it in front.
      const broken = b === '+' ? `+${text}` : `${text.slice(0, at)}${b}${text.slice(at)}`;
      expect(parseFormula(broken).ok, broken).toBe(false);
    }
  });

  it('with no dead series a formula is never dead or partly dead', () => {
    const rand = rng(3);
    const kinds: PartEffect[] = ['live', 'degraded', 'unknown'];
    for (let i = 0; i < RUNS; i++) {
      const text = print(gen(rand, LIVE, 5), rand);
      const map = new Map(LIVE.map((l) => [l, kinds[Math.floor(rand() * 3)] as PartEffect]));
      const v = formulaVerdict(text, map);
      expect(['live', 'degraded', 'unknown'], text).toContain(v.effect);
      if (
        [...map.values()].includes('unknown') &&
        formulaRefs(ast(text)).some((r) => map.get(r) === 'unknown')
      )
        expect(v.effect, text).toBe('unknown');
    }
  });

  it('(E)*X and (E)/X with dead X are dead, also next to an unknown series', () => {
    const rand = rng(4);
    for (let i = 0; i < RUNS; i++) {
      const e = print(gen(rand, [...LIVE, 'U'], 4), rand);
      const map = effects({
        A: 'live',
        B: 'live',
        C: 'degraded',
        D: 'live',
        U: 'unknown',
        X: 'dead',
      });
      for (const text of [`(${e})*X`, `X*(${e})`, `(${e})/X`])
        expect(formulaVerdict(text, map).effect, text).toBe('dead');
    }
  });

  it('(E)+X with dead X is partly dead, or dead when E is itself always 0 or never finite', () => {
    const rand = rng(5);
    let partly = 0;
    for (let i = 0; i < RUNS; i++) {
      const e = print(gen(rand, LIVE, 4), rand);
      const map = effects({ A: 'live', B: 'live', C: 'live', D: 'live', X: 'dead' });
      const v = formulaVerdict(`(${e})+X`, map).effect;
      expect(['partly-dead', 'dead'], e).toContain(v);
      if (v === 'partly-dead') partly++;
    }
    expect(partly).toBeGreaterThan(RUNS * 0.8);
  });

  it('a sum of live series plus a dead one is always exactly partly dead', () => {
    const rand = rng(6);
    for (let i = 0; i < RUNS; i++) {
      const n = 1 + Math.floor(rand() * 4);
      const terms = Array.from({ length: n }, () => LIVE[Math.floor(rand() * 4)] as string);
      terms.splice(Math.floor(rand() * (n + 1)), 0, 'X');
      const text = terms.join('+');
      const map = effects({ A: 'live', B: 'live', C: 'live', D: 'live', X: 'dead' });
      expect(formulaVerdict(text, map).effect, text).toBe('partly-dead');
    }
  });
});
