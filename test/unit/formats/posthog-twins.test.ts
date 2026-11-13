// The PostHog twins (test/fixtures/posthog): one raw response bundle per PostHog shape, and the
// requirements the adapter must write for it, byte for byte (spec 6.5.3, 6.16). The adapter tests
// (T5.2 to T5.4) normalise the raw twins; these tests keep the expected twins valid and canonical.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toCanonicalJson } from '../../../src/formats/canonical.js';
import { formatValidationErrors, validateRequirements } from '../../../src/formats/validate.js';

const DIR = fileURLToPath(new URL('../../fixtures/posthog/', import.meta.url));
const EXPECTED = join(DIR, 'expected');

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

const raws = jsonFiles(DIR);
const expected = jsonFiles(EXPECTED);

// Every key anywhere in a JSON value.
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const item of v) keysOf(item, out);
  else if (typeof v === 'object' && v !== null)
    for (const [k, item] of Object.entries(v)) {
      out.add(k);
      keysOf(item, out);
    }
  return out;
}

describe('PostHog twins', () => {
  it('pairs every raw twin with an expected twin', () => {
    expect(raws.length).toBeGreaterThan(0);
    expect(expected).toEqual(raws);
  });

  it.each(raws)('%s is a bundle of responses with saved insights', (file) => {
    const raw = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as {
      responses: Record<string, { results?: unknown[] }>;
    };
    expect(Object.keys(raw)).toEqual(['responses']);
    expect(raw.responses['insights/?saved=true']?.results?.length).toBeGreaterThan(0);
  });

  it.each(expected)('expected/%s validates and is canonical JSON', (file) => {
    const text = readFileSync(join(EXPECTED, file), 'utf8');
    const data: unknown = JSON.parse(text);
    const r = validateRequirements(data);
    expect(r.ok ? [] : formatValidationErrors(r.errors)).toEqual([]);
    expect(toCanonicalJson(data)).toBe(text);
  });

  it.each(expected)('expected/%s holds no alert values or check history', (file) => {
    const data: unknown = JSON.parse(readFileSync(join(EXPECTED, file), 'utf8'));
    const keys = keysOf(data);
    for (const k of ['threshold', 'last_value', 'checks', 'calculated_value', 'configuration'])
      expect(keys.has(k)).toBe(false);
  });
});
