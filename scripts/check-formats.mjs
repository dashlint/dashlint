#!/usr/bin/env node
// check:formats (spec T2.5, the E-FORMATS gate): every fixture under test/fixtures/formats and
// test/fixtures/posthog is checked against its schema and listed with PASS or FAIL. A file no rule
// covers fails, so a new fixture cannot go unchecked.
//
// - Valid fixtures validate. Requirements (the one format with a YAML form, spec D8) are stored as
//   canonical JSON, and JSON -> YAML -> JSON gives the file back byte for byte; YAML -> JSON -> YAML
//   is byte-stable. Catalogs and reports are JSON only: their canonical JSON is byte-stable.
// - Invalid fixtures are refused at the field (or YAML line) their index file names.
// - Hand-written YAML loads to its expected expansion and round trips from there.
// - Raw PostHog twins are adapter input in PostHog's own shape: each parses and has its expected
//   requirements twin (and the other way round).
//
// It runs the built formats module, so build first (`npm run check:formats` does).
//
// Usage: node scripts/check-formats.mjs [--fixtures <dir>]   (default test/fixtures)
// Exit: 0 every fixture passed, 1 at least one failed, 2 dist/ is missing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const ROOTS = ['formats', 'posthog'];

// Every file under `dir`, as sorted paths relative to it with `/` separators.
function listFiles(dir, prefix = '') {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) return listFiles(abs, `${prefix}${name}/`);
      return name === '.gitkeep' ? [] : [`${prefix}${name}`];
    });
}

// The first line where `text` and `canonical` differ, for a readable failure.
function firstDifference(text, canonical) {
  const a = text.split('\n');
  const b = canonical.split('\n');
  const i = a.findIndex((line, n) => line !== b[n]);
  const n = i === -1 ? a.length : i;
  return `line ${n + 1} is ${JSON.stringify(a[n] ?? '')}, the canonical writer has ${JSON.stringify(b[n] ?? '')}`;
}

/**
 * Checks every fixture under `fixtures` with the formats module `f` (the built dist/formats, or
 * src/formats in the tests). Returns the exit code and the lines to print.
 */
export function evaluate(f, fixtures) {
  const files = ROOTS.flatMap((r) =>
    existsSync(join(fixtures, r)) ? listFiles(join(fixtures, r)).map((p) => `${r}/${p}`) : [],
  );
  const has = (rel) => files.includes(rel);
  const read = (rel) => readFileSync(join(fixtures, rel), 'utf8');
  const readJson = (rel) => JSON.parse(read(rel));
  const validators = {
    catalog: f.validateCatalog,
    report: f.validateReport,
    requirements: f.validateRequirements,
  };

  function mustValidate(schema, data) {
    const r = validators[schema](data);
    if (!r.ok)
      throw new Error(`not a valid ${schema}: ${f.formatValidationErrors(r.errors).join('; ')}`);
  }

  function loadYaml(text) {
    const r = f.loadRequirements(text);
    if (!r.ok) throw new Error(`does not load: ${f.formatValidationErrors(r.errors).join('; ')}`);
    return r.value;
  }

  // Both round trips of a requirements value; returns its canonical JSON.
  function requirementsRoundTrip(value) {
    const json = f.toCanonicalJson(value);
    if (!isDeepStrictEqual(JSON.parse(json), value))
      throw new Error('the canonical JSON writer changed a value');
    const yaml = f.toCanonicalYaml(loadYaml(json));
    const json2 = f.toCanonicalJson(loadYaml(yaml));
    if (json2 !== json)
      throw new Error(`JSON -> YAML -> JSON changed the bytes: ${firstDifference(json2, json)}`);
    const yaml2 = f.toCanonicalYaml(loadYaml(json2));
    if (yaml2 !== yaml)
      throw new Error(`YAML -> JSON -> YAML changed the bytes: ${firstDifference(yaml2, yaml)}`);
    return json;
  }

  function canonicalRequirementsFile(rel) {
    const text = read(rel);
    const value = JSON.parse(text);
    mustValidate('requirements', value);
    const json = requirementsRoundTrip(value);
    if (text !== json)
      throw new Error(
        `the round trip does not give the file back (key order or layout): ${firstDifference(text, json)}`,
      );
    return 'valid requirements; canonical JSON; JSON -> YAML -> JSON gives the file back, YAML -> JSON -> YAML byte-stable';
  }

  function needs(rel, what) {
    if (!has(rel)) throw new Error(`${what} ${rel} is missing`);
  }

  function index(rel, dir, ext) {
    const cases = readJson(rel);
    const listed = Object.keys(cases).sort();
    const present = files
      .filter((p) => p.startsWith(`${dir}/`) && p.endsWith(ext))
      .map((p) => p.slice(dir.length + 1))
      .sort();
    const noFile = listed.filter((name) => !present.includes(name));
    const noCase = present.filter((name) => !listed.includes(name));
    if (noFile.length) throw new Error(`cases without a fixture: ${noFile.join(', ')}`);
    if (noCase.length) throw new Error(`fixtures without a case: ${noCase.join(', ')}`);
    return `index of ${listed.length} cases, each with its fixture`;
  }

  const rules = [
    [/^formats\/(requirements)\/valid\/[^/]+\.json$/, (rel) => canonicalRequirementsFile(rel)],
    [
      /^formats\/(catalog|report)\/valid\/[^/]+\.json$/,
      (rel, [, schema]) => {
        const value = readJson(rel);
        mustValidate(schema, value);
        const json = f.toCanonicalJson(value);
        if (!isDeepStrictEqual(JSON.parse(json), value))
          throw new Error('the canonical JSON writer changed a value');
        if (f.toCanonicalJson(JSON.parse(json)) !== json)
          throw new Error('canonical JSON is not byte-stable');
        return `valid ${schema}; canonical JSON byte-stable (JSON only, no YAML form)`;
      },
    ],
    [
      /^formats\/(catalog|report|requirements)\/invalid\/([^/]+\.json)$/,
      (rel, [, schema, name]) => {
        const cases = readJson(`formats/${schema}/invalid-cases.json`);
        const expected = cases[name];
        if (!expected) throw new Error(`no case for ${name} in invalid-cases.json`);
        const r = validators[schema](readJson(rel));
        if (r.ok) throw new Error(`accepted; expected an error at ${expected.path}`);
        if (!r.errors.some((e) => e.path === expected.path))
          throw new Error(
            `refused, but not at ${expected.path}: ${f.formatValidationErrors(r.errors).join('; ')}`,
          );
        return `refused at ${expected.path}`;
      },
    ],
    [
      /^formats\/(catalog|report|requirements)\/invalid-cases\.json$/,
      (rel, [, schema]) => index(rel, `formats/${schema}/invalid`, '.json'),
    ],
    [
      /^formats\/requirements\/yaml\/([^/]+)\.expected\.json$/,
      (rel, [, base]) => {
        needs(`formats/requirements/yaml/${base}.yaml`, 'its YAML source');
        return canonicalRequirementsFile(rel);
      },
    ],
    [
      /^formats\/requirements\/yaml\/([^/]+)\.yaml$/,
      (rel, [, base]) => {
        const value = loadYaml(read(rel));
        const expected = [
          `formats/requirements/yaml/${base}.expected.json`,
          `formats/requirements/valid/${base}-expanded.json`,
        ].find(has);
        if (!expected) throw new Error(`no expected expansion for ${base}.yaml`);
        if (f.toCanonicalJson(value) !== f.toCanonicalJson(readJson(expected)))
          throw new Error(`does not expand to ${expected}`);
        requirementsRoundTrip(value);
        return `loads and expands to ${expected}; round trips byte-stable from there (authoring form with shorthands)`;
      },
    ],
    [
      /^formats\/requirements\/yaml-invalid\/([^/]+\.yaml)$/,
      (rel, [, name]) => {
        const expected = readJson('formats/requirements/yaml-invalid/cases.json')[name];
        if (!expected) throw new Error(`no case for ${name} in cases.json`);
        const r = f.loadRequirements(read(rel));
        if (r.ok) throw new Error(`loaded; expected a refusal at line ${expected.line}`);
        if (!r.errors.some((e) => e.line === expected.line && e.message.includes(expected.message)))
          throw new Error(
            `refused, but not at line ${expected.line} with "${expected.message}": ${f.formatValidationErrors(r.errors).join('; ')}`,
          );
        return `refused at line ${expected.line}`;
      },
    ],
    [
      /^formats\/requirements\/yaml-invalid\/cases\.json$/,
      (rel) => index(rel, 'formats/requirements/yaml-invalid', '.yaml'),
    ],
    [
      /^posthog\/expected\/([^/]+\.json)$/,
      (rel, [, name]) => {
        needs(`posthog/${name}`, 'its raw twin');
        return canonicalRequirementsFile(rel);
      },
    ],
    [
      /^posthog\/([^/]+\.json)$/,
      (rel, [, name]) => {
        const raw = readJson(rel);
        const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
        if (keys.join() !== 'responses' || typeof raw.responses !== 'object')
          throw new Error('is not a bundle of PostHog responses ({ "responses": { ... } })');
        needs(`posthog/expected/${name}`, 'its expected twin');
        return `raw PostHog responses (adapter input, PostHog's shape), paired with expected/${name}`;
      },
    ],
  ];

  const out = [];
  let failed = 0;
  for (const rel of files) {
    const rule = rules.find(([re]) => re.test(rel));
    let line;
    try {
      if (!rule) throw new Error('no rule covers this fixture');
      line = `PASS  ${rel}: ${rule[1](rel, rel.match(rule[0]))}`;
    } catch (e) {
      failed++;
      line = `FAIL  ${rel}: ${e.message}`;
    }
    out.push(line);
  }
  if (files.length === 0) {
    failed++;
    out.push(`FAIL  no fixtures under ${fixtures}`);
  }
  out.push(
    `check:formats: ${files.length} fixtures, ${files.length - failed} PASS, ${failed} FAIL`,
    failed ? 'FAIL' : 'PASS',
  );
  return { code: failed ? 1 : 0, out };
}

export async function run(argv) {
  const at = argv.indexOf('--fixtures');
  if (at !== -1 && !argv[at + 1]) {
    process.stdout.write('usage: node scripts/check-formats.mjs [--fixtures <dir>]\n');
    return 2;
  }
  const fixtures = resolve(at === -1 ? join(ROOT, 'test', 'fixtures') : argv[at + 1]);
  const entry = join(ROOT, 'dist', 'formats', 'index.js');
  if (!existsSync(entry)) {
    process.stdout.write(`check:formats: ${entry} is missing (run npm run build first)\n`);
    return 2;
  }
  const formats = await import(pathToFileURL(entry).href);
  const { code, out } = evaluate(formats, fixtures);
  process.stdout.write(`${out.join('\n')}\n`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
