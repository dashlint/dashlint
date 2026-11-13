import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toCanonicalJson, toCanonicalYaml } from '../../../src/formats/canonical.js';
import { formatValidationErrors } from '../../../src/formats/validate.js';
import { expandRequirements, loadRequirements, refLetter } from '../../../src/formats/yaml.js';
import { FIXTURES, fixture, fixtureFiles, readJson } from './fixtures.js';

const YAML_DIR = join(FIXTURES, 'requirements', 'yaml');
const INVALID_DIR = join(FIXTURES, 'requirements', 'yaml-invalid');
const yamlFixtures = ['every-shorthand.yaml', 'hand-written.yaml'];

function text(dir: string, file: string): string {
  return readFileSync(join(dir, file), 'utf8');
}

function load(source: string) {
  const r = loadRequirements(source);
  if (!r.ok) throw new Error(formatValidationErrors(r.errors).join('\n'));
  return r.value;
}

// One tile of one series around `node`, with `tile` fields merged in.
function oneTile(node: Record<string, unknown>, tile: Record<string, unknown> = {}) {
  return {
    schema: 'dashlint.requirements/1',
    source: { platform: 'posthog' },
    tiles: [{ id: 't', title: 'T', kind: 'trends', series: [node], ...tile }],
  };
}

function expandedTile(data: unknown) {
  const tiles = (expandRequirements(data) as { tiles: Record<string, unknown>[] }).tiles;
  const tile = tiles[0];
  if (!tile) throw new Error('no tile');
  return tile;
}

function firstSeries(data: unknown) {
  return (expandedTile(data)['series'] as Record<string, unknown>[])[0];
}

function firstFilter(data: unknown) {
  return (firstSeries(data)?.['filters'] as unknown[])[0];
}

describe('spec 6.6 shorthands, each with the explicit form kept (negative)', () => {
  it('node defaults to event when event is present, and only then', () => {
    expect(firstSeries(oneTile({ event: 'book_viewed' }))?.['node']).toBe('event');
    expect(firstSeries(oneTile({ node: 'group', event: 'book_viewed' }))?.['node']).toBe('group');
    expect(firstSeries(oneTile({ math: 'dau' }))).not.toHaveProperty('node');
    const members = firstSeries(
      oneTile({ node: 'group', operator: 'OR', events: [{ event: 'book_viewed' }] }),
    )?.['events'];
    expect(members).toEqual([{ event: 'book_viewed' }]);
  });

  it('node defaults on exclusions and retention entities too, without a ref', () => {
    const tile = expandedTile(
      oneTile(
        { event: 'book_viewed' },
        {
          exclusions: [{ event: 'wishlist_shared', fromStep: 0, toStep: 1 }],
          retention: { target: { event: 'reader_opened' }, returning: { node: 'all-events' } },
        },
      ),
    );
    expect(tile['exclusions']).toEqual([
      { node: 'event', event: 'wishlist_shared', fromStep: 0, toStep: 1 },
    ]);
    expect(tile['retention']).toEqual({
      target: { node: 'event', event: 'reader_opened' },
      returning: { node: 'all-events' },
    });
  });

  it('scope defaults to event on filters, math properties and breakdown objects', () => {
    expect(
      firstFilter(oneTile({ event: 'e', filters: [{ key: 'format', values: ['x'] }] })),
    ).toEqual({ key: 'format', scope: 'event', op: 'exact', values: ['x'] });
    const explicit = { key: 'plan', scope: 'person', op: 'exact', values: ['x'] };
    expect(firstFilter(oneTile({ event: 'e', filters: [explicit] }))).toEqual(explicit);
    expect(firstSeries(oneTile({ event: 'e', mathProperty: { key: 'total' } }))).toMatchObject({
      mathProperty: { key: 'total', scope: 'event' },
    });
    expect(
      firstSeries(oneTile({ event: 'e', mathProperty: { key: 'age', scope: 'person' } })),
    ).toMatchObject({ mathProperty: { key: 'age', scope: 'person' } });
  });

  it('op defaults to exact', () => {
    expect(
      firstFilter(oneTile({ event: 'e', filters: [{ key: 'k', values: [1] }] })),
    ).toHaveProperty('op', 'exact');
    expect(
      firstFilter(oneTile({ event: 'e', filters: [{ key: 'k', op: 'is_not', values: [1] }] })),
    ).toHaveProperty('op', 'is_not');
  });

  it('a breakdown string means { key, scope: event }', () => {
    const tile = expandedTile(
      oneTile({ event: 'e' }, { breakdown: ['format', { key: 'country', scope: 'person' }] }),
    );
    expect(tile['breakdown']).toEqual([
      { key: 'format', scope: 'event' },
      { key: 'country', scope: 'person' },
    ]);
  });

  it('ref letters are assigned in order; a written ref is kept', () => {
    const data = oneTile(
      { event: 'a' },
      { series: [{ event: 'a' }, { ref: 'Q', event: 'b' }, { event: 'c' }] },
    );
    const refs = (expandedTile(data)['series'] as { ref: string }[]).map((s) => s.ref);
    expect(refs).toEqual(['A', 'Q', 'C']);
    expect([0, 1, 25, 26, 27, 51, 52, 701].map(refLetter)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
    ]);
  });

  it('values may be a scalar; a list is kept as it is', () => {
    for (const [values, want] of [
      ['card', ['card']],
      [true, [true]],
      [0, [0]],
      [null, [null]],
      [['card'], ['card']],
      [[], []],
      [[['nested']], [['nested']]],
    ] as const) {
      const f = firstFilter(oneTile({ event: 'e', filters: [{ key: 'k', values }] }));
      expect(f).toHaveProperty('values', want);
    }
  });

  it('expands inside OR groups, group members, action steps, tile and dashboard filters', () => {
    const r = load(text(YAML_DIR, 'every-shorthand.yaml'));
    expect(r).toEqual(readJson(join(YAML_DIR, 'every-shorthand.expected.json')));
  });

  it('expands the spec 6.6 example into the canonical form of ADR-017', () => {
    expect(load(text(YAML_DIR, 'hand-written.yaml'))).toEqual(
      fixture('requirements', 'valid', 'hand-written-expanded.json'),
    );
  });

  it('leaves the canonical form unchanged and never mutates its input', () => {
    for (const file of fixtureFiles('requirements', 'valid')) {
      const data = fixture('requirements', 'valid', file);
      const before = structuredClone(data);
      expect(expandRequirements(data)).toEqual(data);
      expect(data).toEqual(before);
    }
  });

  it('leaves shapes it does not know for the validator', () => {
    for (const data of [null, 'x', [], { tiles: 'x' }, { tiles: [1, { series: 'x' }] }])
      expect(expandRequirements(data)).toEqual(data);
  });
});

describe('canonical writers and round trips', () => {
  // Every valid JSON fixture and every YAML fixture, loaded inside each test.
  const files = [
    ...fixtureFiles('requirements', 'valid').map((f) => `valid/${f}`),
    ...yamlFixtures.map((f) => `yaml/${f}`),
  ];
  const loaded = (file: string) => load(text(join(FIXTURES, 'requirements'), file));

  it.each(files)('YAML -> JSON -> YAML is byte-stable on %s', (file) => {
    const yaml = toCanonicalYaml(loaded(file));
    const json = toCanonicalJson(load(yaml));
    expect(toCanonicalYaml(load(json))).toBe(yaml);
  });

  it.each(files)('JSON -> YAML -> JSON is byte-stable on %s', (file) => {
    const json = toCanonicalJson(loaded(file));
    const yaml = toCanonicalYaml(load(json));
    expect(toCanonicalJson(load(yaml))).toBe(json);
  });

  it.each(files)('keeps the value through both writers on %s', (file) => {
    const value = loaded(file);
    expect(load(toCanonicalJson(value))).toEqual(value);
    expect(load(toCanonicalYaml(value))).toEqual(value);
    expect(JSON.parse(toCanonicalJson(value))).toEqual(value);
  });

  it('orders keys the same whatever order they were written in', () => {
    const a = { tiles: [], source: { note: 'n', platform: 'posthog' }, schema: 'x' };
    const b = { schema: 'x', source: { platform: 'posthog', note: 'n' }, tiles: [] };
    expect(toCanonicalJson(a)).toBe(toCanonicalJson(b));
    expect(toCanonicalYaml(a)).toBe(toCanonicalYaml(b));
    expect(toCanonicalJson(a)).toBe(
      '{\n  "schema": "x",\n  "source": {\n    "platform": "posthog",\n    "note": "n"\n  },\n  "tiles": []\n}\n',
    );
  });

  it('sorts event names by code point, integer-like names included', () => {
    const value = { observed: { windowDays: 30, events: { b: 1, '10': 2, a: 3, '9': 4, B: 5 } } };
    // Read from the text: JSON.parse would move integer-like keys to the front again.
    const order = [...toCanonicalJson(value).matchAll(/^ {6}"([^"]+)":/gm)].map((m) => m[1]);
    expect(order).toEqual(['10', '9', 'B', 'a', 'b']);
    expect(toCanonicalYaml(value).indexOf('"10"')).toBeLessThan(
      toCanonicalYaml(value).indexOf('a:'),
    );
  });

  it('keeps JSON types and awkward strings through YAML', () => {
    const values = [
      'true',
      true,
      '1',
      1,
      1.5,
      '1.50',
      'null',
      null,
      '',
      ' lead',
      'trail ',
      'two\nlines',
      '#hash',
      '- dash',
      'a: b',
      '~',
      'yes',
      'it\'s "quoted"',
      'café',
      '0x1F',
      '2026-12-10',
      'x'.repeat(200),
    ];
    const value = oneTile({
      event: 'e',
      filters: [{ key: 'k', scope: 'event', op: 'exact', values }],
    });
    const r = load(toCanonicalYaml(load(toCanonicalJson(value))));
    expect(firstFilter(r)).toEqual({ key: 'k', scope: 'event', op: 'exact', values });
  });

  it('writes -0 as 0 and repeated objects without anchors', () => {
    const shared = { key: 'k', scope: 'event', op: 'exact', values: [-0] };
    const value = oneTile({ event: 'e', filters: [shared, shared] });
    expect(toCanonicalYaml(value)).not.toMatch(/[&*]/);
    expect(toCanonicalJson(value)).not.toContain('-0');
  });
});

describe('safe parsing, every error with its line (negative controls)', () => {
  const cases = readJson(join(INVALID_DIR, 'cases.json')) as Record<
    string,
    { line: number; message: string }
  >;

  it.each(Object.entries(cases))('refuses %s and names the line', (file, c) => {
    const r = loadRequirements(text(INVALID_DIR, file));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: c.line, message: expect.stringContaining(c.message) }),
      ]),
    );
  });

  it('refuses a !!js/function tag with its line in the formatted message', () => {
    const r = loadRequirements(text(INVALID_DIR, 'js-function-tag.yaml'));
    expect(r.ok ? [] : formatValidationErrors(r.errors)).toEqual([
      'line 5: the tag !!js/function is not allowed; dashlint reads plain YAML only',
    ]);
  });

  it('refuses a duplicate key with its line in the formatted message', () => {
    const r = loadRequirements(text(INVALID_DIR, 'duplicate-key.yaml'));
    expect(r.ok ? [] : formatValidationErrors(r.errors)).toEqual(['line 12: duplicate key "key"']);
  });

  it('refuses every YAML 1.1 tag the parser would otherwise resolve', () => {
    for (const tag of ['!!binary aGk=', '!!timestamp 2026-12-10', '!!set {a: null}', '!!omap []']) {
      const r = loadRequirements(`schema: dashlint.requirements/1\nsource: ${tag}\ntiles: []\n`);
      expect(r.ok ? [] : r.errors.map((e) => e.line)).toEqual([2]);
    }
  });

  it('accepts the core tags', () => {
    const r = loadRequirements(
      'schema: !!str dashlint.requirements/1\nsource: !!map { platform: posthog }\ntiles: !!seq []\n',
    );
    expect(r.ok).toBe(true);
  });

  it('points a schema error at the key, or at the parent of a field the expansion added', () => {
    const source = [
      'schema: dashlint.requirements/1',
      'source: { platform: posthog }',
      'tiles:',
      '  - id: t',
      '    kind: trends',
      '    series:',
      '      - event: a',
      '      - { ref: A, event: b }',
      '',
    ].join('\n');
    const r = loadRequirements(source);
    expect(r.ok ? [] : r.errors.map((e) => [e.path, e.line])).toEqual([['/tiles/0/title', 4]]);
    const dup = loadRequirements(source.replace('    kind', '    title: T\n    kind'));
    expect(dup.ok ? [] : formatValidationErrors(dup.errors)).toEqual([
      'line 9, /tiles/0/series/1/ref: series ref A is used twice in this tile',
    ]);
    const added = loadRequirements(
      source
        .replace('    kind', '    title: T\n    kind')
        .replace('- event: a', '- { ref: B, event: a }')
        .replace('{ ref: A, event: b }', 'event: b'),
    );
    expect(added.ok ? [] : formatValidationErrors(added.errors)).toEqual([
      'line 9, /tiles/0/series/1/ref: series ref B is used twice in this tile',
    ]);
  });

  it('reads an empty file as a top-level error at line 1', () => {
    const r = loadRequirements('');
    expect(r.ok ? [] : formatValidationErrors(r.errors)).toEqual([
      expect.stringMatching(/^\(top level\): |^line 1: /),
    ]);
  });
});
