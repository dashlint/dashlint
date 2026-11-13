import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate, runtimeImports } from '../../../scripts/build-validators.mjs';

const GENERATED = fileURLToPath(
  new URL('../../../src/formats/generated/validators.ts', import.meta.url),
);

describe('standalone validators', () => {
  it('are up to date with the schemas', () => {
    expect(readFileSync(GENERATED, 'utf8')).toBe(generate());
  });

  it('load nothing at runtime, so ajv stays a build-time tool', () => {
    expect(runtimeImports(readFileSync(GENERATED, 'utf8'))).toEqual([]);
  });

  it('flag a runtime helper in generated code (negative control)', () => {
    const code =
      'const func2 = require("ajv/dist/runtime/ucs2length").default;\nexport const x = 1;';
    expect(runtimeImports(code)).toHaveLength(1);
    expect(runtimeImports('import equal from "ajv/dist/runtime/equal";')).toHaveLength(1);
  });
});
