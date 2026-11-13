import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluate } from '../../../scripts/check-formats.mjs';
import * as formats from '../../../src/formats/index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

function countFiles(dir: string): number {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(
    (d) => d.isFile() && d.name !== '.gitkeep',
  ).length;
}

const scratches: string[] = [];

// A scratch copy of the format and PostHog fixtures, with `change` applied to it.
function scratch(change: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dashlint-formats-'));
  scratches.push(dir);
  for (const root of ['formats', 'posthog'])
    cpSync(join(FIXTURES, root), join(dir, root), { recursive: true });
  change(dir);
  return dir;
}

function failures(dir: string): string[] {
  const r = evaluate(formats, dir);
  expect(r.code).toBe(1);
  expect(r.out.at(-1)).toBe('FAIL');
  return r.out.filter((l) => l.startsWith('FAIL  '));
}

const BASE = 'formats/requirements/valid/base.json';

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-formats', () => {
  it('passes on the committed fixtures and lists every one of them', () => {
    const r = evaluate(formats, FIXTURES);
    const total = countFiles(join(FIXTURES, 'formats')) + countFiles(join(FIXTURES, 'posthog'));
    expect(r.out.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(r.out.filter((l) => l.startsWith('PASS  '))).toHaveLength(total);
    expect(r.out.at(-2)).toBe(`check:formats: ${total} fixtures, ${total} PASS, 0 FAIL`);
    expect(r.code).toBe(0);
  });

  it('fails a requirements fixture whose round trip reorders keys (negative control)', () => {
    const dir = scratch((d) => {
      const { schema, source, ...rest } = JSON.parse(readFileSync(join(d, BASE), 'utf8')) as Record<
        string,
        unknown
      >;
      writeFileSync(
        join(d, BASE),
        formats
          .toCanonicalJson(rest)
          .replace(
            /^\{\n/,
            `{\n  "source": ${JSON.stringify(source)},\n  "schema": ${JSON.stringify(schema)},\n`,
          ),
      );
    });
    const f = failures(dir);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(
      /^FAIL {2}formats\/requirements\/valid\/base\.json: the round trip does not give the file back \(key order or layout\): line 2/,
    );
  });

  it('fails a valid fixture that does not validate', () => {
    const file = 'formats/catalog/valid/base.json';
    const dir = scratch((d) => {
      const value = JSON.parse(readFileSync(join(d, file), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(d, file), JSON.stringify({ ...value, schema: 'dashlint.catalog/2' }));
    });
    expect(failures(dir)).toEqual([
      expect.stringMatching(
        /^FAIL {2}formats\/catalog\/valid\/base\.json: not a valid catalog: \/schema/,
      ),
    ]);
  });

  it('fails an invalid fixture that is accepted, or refused at another field', () => {
    const dir = scratch((d) => {
      cpSync(join(d, BASE), join(d, 'formats/requirements/invalid/tile-kind-unknown.json'));
      const index = join(d, 'formats/report/invalid-cases.json');
      const cases = JSON.parse(readFileSync(index, 'utf8')) as Record<string, { path: string }>;
      cases['verdict-unknown.json'] = { path: '/elsewhere' };
      writeFileSync(index, JSON.stringify(cases));
    });
    const f = failures(dir).join('\n');
    expect(f).toMatch(/tile-kind-unknown\.json: accepted; expected an error at \/tiles\/0\/kind/);
    expect(f).toMatch(/verdict-unknown\.json: refused, but not at \/elsewhere: /);
  });

  it('fails an invalid fixture with no case, and the index that misses it', () => {
    const dir = scratch((d) =>
      cpSync(
        join(d, 'formats/report/invalid/kind-unknown.json'),
        join(d, 'formats/report/invalid/stray.json'),
      ),
    );
    const f = failures(dir).join('\n');
    expect(f).toMatch(/report\/invalid\/stray\.json: no case for stray\.json/);
    expect(f).toMatch(/report\/invalid-cases\.json: fixtures without a case: stray\.json/);
  });

  it('fails a case whose fixture is gone', () => {
    const dir = scratch((d) => rmSync(join(d, 'formats/requirements/yaml-invalid/merge-key.yaml')));
    expect(failures(dir)).toEqual([
      expect.stringMatching(/yaml-invalid\/cases\.json: cases without a fixture: merge-key\.yaml/),
    ]);
  });

  it('fails a YAML refusal at the wrong line', () => {
    const file = 'formats/requirements/yaml-invalid/duplicate-key.yaml';
    const dir = scratch((d) =>
      writeFileSync(join(d, file), `# moved down\n${readFileSync(join(d, file), 'utf8')}`),
    );
    expect(failures(dir)).toEqual([
      expect.stringMatching(/duplicate-key\.yaml: refused, but not at line 12/),
    ]);
  });

  it('fails hand-written YAML that expands to something else', () => {
    const file = 'formats/requirements/yaml/hand-written.yaml';
    const dir = scratch((d) =>
      writeFileSync(
        join(d, file),
        readFileSync(join(d, file), 'utf8').replace(/^(\s+title: ).*$/m, '$1Changed'),
      ),
    );
    expect(failures(dir)).toEqual([
      expect.stringMatching(
        /hand-written\.yaml: does not expand to formats\/requirements\/valid\/hand-written-expanded\.json/,
      ),
    ]);
  });

  it('fails a raw PostHog twin without its expected twin, and the other way round', () => {
    const dir = scratch((d) => {
      rmSync(join(d, 'posthog/expected/retention.json'));
      rmSync(join(d, 'posthog/trends-math.json'));
    });
    const f = failures(dir).join('\n');
    expect(f).toMatch(
      /posthog\/retention\.json: its expected twin posthog\/expected\/retention\.json is missing/,
    );
    expect(f).toMatch(
      /posthog\/expected\/trends-math\.json: its raw twin posthog\/trends-math\.json is missing/,
    );
  });

  it('fails a raw twin that is not a bundle of responses', () => {
    const dir = scratch((d) => writeFileSync(join(d, 'posthog/alerts.json'), '{"results": []}\n'));
    expect(failures(dir)).toEqual([
      expect.stringMatching(/posthog\/alerts\.json: is not a bundle of PostHog responses/),
    ]);
  });

  it('fails a file no rule covers, and a file that is not JSON', () => {
    const dir = scratch((d) => {
      writeFileSync(join(d, 'formats/notes.txt'), 'stray\n');
      writeFileSync(join(d, 'formats/report/valid/broken.json'), '{');
    });
    const f = failures(dir).join('\n');
    expect(f).toMatch(/formats\/notes\.txt: no rule covers this fixture/);
    expect(f).toMatch(/formats\/report\/valid\/broken\.json: /);
  });

  it('fails when there are no fixtures at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashlint-formats-'));
    scratches.push(dir);
    expect(failures(dir)).toEqual([`FAIL  no fixtures under ${dir}`]);
  });
});
