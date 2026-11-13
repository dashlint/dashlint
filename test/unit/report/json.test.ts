import { describe, expect, it } from 'vitest';
import { validateReport } from '../../../src/formats/validate.js';
import { InvalidReportError, renderJson } from '../../../src/report/index.js';
import { bookshop } from '../../fixtures/report/bookshop.js';
import { diffRequirements, headCatalogs } from '../../fixtures/report/bookshop-diff.js';
import { expectGolden } from './golden.js';

const goldens = {
  'json/bookshop.json': () => bookshop(),
  'json/bookshop-code-only.json': () => bookshop({ observed: false }),
  'json/bookshop-no-ignore.json': () => bookshop({ ignore: [] }),
  'json/bookshop-diff-head.json': () =>
    bookshop({ catalogs: headCatalogs(), requirements: diffRequirements(), mode: 'diff' }),
};

describe('JSON report goldens (spec 6.9.4)', () => {
  for (const [file, model] of Object.entries(goldens))
    it(file, () => {
      expectGolden(file, renderJson(model()));
    });

  it('every golden validates against report.schema.json', () => {
    for (const model of Object.values(goldens)) {
      const v = validateReport(JSON.parse(renderJson(model())));
      expect(v.ok ? [] : v.errors).toEqual([]);
    }
  });
});

describe('renderJson', () => {
  it('serialises the model report unchanged, two-space indented, with a final newline', () => {
    const m = bookshop();
    const text = renderJson(m);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(m.report)));
    expect(text.startsWith('{\n  "schema": "dashlint.report/1",\n  "tool": "0.1.0",')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('accepts the report object as well as the model', () => {
    const m = bookshop();
    expect(renderJson(m.report)).toBe(renderJson(m));
  });

  it("refuses a report missing a tile's unknownParts (negative control)", () => {
    const broken = structuredClone(bookshop().report);
    delete (broken.tiles[0] as Partial<(typeof broken.tiles)[number]>).unknownParts;
    expect(() => renderJson(broken)).toThrow(InvalidReportError);
    expect(() => renderJson(broken)).toThrow(/unknownParts/);
  });

  it('refuses a report missing summary.unknownParts (negative control)', () => {
    const broken = structuredClone(bookshop().report);
    delete (broken.summary as Partial<typeof broken.summary>).unknownParts;
    expect(() => renderJson(broken)).toThrow(/unknownParts/);
  });
});
