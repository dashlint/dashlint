// Golden files: compared byte for byte; written only with UPDATE_GOLDEN=1 (T7.1 constraint).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../golden');

export function expectGolden(relative: string, actual: string): void {
  const file = join(ROOT, relative);
  if (process.env['UPDATE_GOLDEN'] === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  if (!existsSync(file)) throw new Error(`no golden ${relative}; run with UPDATE_GOLDEN=1`);
  expect(actual).toBe(readFileSync(file, 'utf8'));
}
