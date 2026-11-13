import { describe, expect, it } from 'vitest';
import { validateReport } from '../../../src/formats/validate.js';
import { CLOSING_SENTENCE, renderText, wrap } from '../../../src/report/index.js';
import { bookshop } from '../../fixtures/report/bookshop.js';
import { expectGolden } from './golden.js';

describe('text report goldens (spec 6.9.3)', () => {
  it('the bookshop with PostHog data', () => {
    expectGolden('text/bookshop.txt', renderText(bookshop(), { htmlFile: 'dashlint-report.html' }));
  });

  it('the bookshop from code alone', () => {
    expectGolden('text/bookshop-code-only.txt', renderText(bookshop({ observed: false })));
  });

  it('the bookshop with no ignore list', () => {
    expectGolden('text/bookshop-no-ignore.txt', renderText(bookshop({ ignore: [] })));
  });
});

describe('text report invariants', () => {
  const variants = [bookshop(), bookshop({ observed: false }), bookshop({ ignore: [] })];

  it('ends with the closing sentence (G11)', () => {
    for (const m of variants) expect(renderText(m).endsWith(`${CLOSING_SENTENCE}\n`)).toBe(true);
  });

  it('always prints the unknown count and the alert counts, also at zero', () => {
    for (const m of variants) {
      expect(renderText(m)).toMatch(/^Unknown: \d+ parts? could not be decided/m);
      expect(renderText(m)).toMatch(/^Alerts: \d+ checked/m);
    }
  });

  it('has no em or en dash and no line over 100 columns', () => {
    for (const m of variants) {
      const text = renderText(m);
      expect(text).not.toContain(String.fromCodePoint(0x2013));
      expect(text).not.toContain(String.fromCodePoint(0x2014));
      for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it('lists no live tile and every tile that is not live or ignored', () => {
    const m = bookshop();
    const text = renderText(m);
    for (const t of m.report.tiles) {
      const listed = new RegExp(`^[A-Z ]{14}${t.title}`, 'm').test(text);
      expect(listed).toBe(t.verdict !== 'live' && t.verdict !== 'ignored');
    }
  });

  it('builds reports that validate against dashlint.report/1', () => {
    for (const m of variants) {
      const v = validateReport(JSON.parse(JSON.stringify(m.report)));
      expect(v.ok ? [] : v.errors).toEqual([]);
    }
  });

  it('a report with no catalogs, tiles or alerts still has the header counts and closing', () => {
    const m = bookshop();
    const empty = {
      ...m,
      report: {
        ...m.report,
        tiles: [],
        alerts: [],
        notArriving: [],
        summary: {
          ...m.report.summary,
          unknownParts: 0,
          alerts: { checked: 0, canNeverFire: 0, firesEveryCheck: 0, invalidTarget: 0 },
        },
      },
      sources: [],
      warnings: [],
    };
    expect(renderText(empty)).toBe(
      [
        'dashlint 0.1.0 · PostHog project 12345 · snapshot pulled 2026-12-18 09:12 UTC',
        'Sources: none',
        'Catalog: 0 call sites',
        '',
        'Alerts: 0 checked · 0 can never fire · 0 invalid targets',
        'Unknown: 0 parts could not be decided and are counted as not checked.',
        CLOSING_SENTENCE,
        '',
      ].join('\n'),
    );
  });
});

describe('wrap', () => {
  it('keeps short text on one line after the indent', () => {
    expect(wrap('a b c', 4)).toEqual(['    a b c']);
  });

  it('breaks before the word that would pass the width', () => {
    expect(wrap('aaa bbb ccc', 2, 9)).toEqual(['  aaa bbb', '  ccc']);
  });

  it('never breaks inside a word longer than the width', () => {
    expect(wrap('abcdefghijkl x', 0, 5)).toEqual(['abcdefghijkl', 'x']);
  });
});
