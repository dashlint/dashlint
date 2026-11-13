import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const FIXTURES = fileURLToPath(new URL('../../fixtures/formats/', import.meta.url));

export interface InvalidCase {
  path: string;
  rule: string;
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function fixtureFiles(schema: string, kind: 'valid' | 'invalid'): string[] {
  return readdirSync(join(FIXTURES, schema, kind))
    .filter((f) => f.endsWith('.json'))
    .sort();
}

export function fixture(schema: string, kind: 'valid' | 'invalid', file: string): unknown {
  return readJson(join(FIXTURES, schema, kind, file));
}

export function invalidCases(schema: string): Record<string, InvalidCase> {
  return readJson(join(FIXTURES, schema, 'invalid-cases.json')) as Record<string, InvalidCase>;
}
