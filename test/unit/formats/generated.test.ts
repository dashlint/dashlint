import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate, runtimeImports, TARGETS } from '../../../scripts/build-validators.mjs';

const ROOT = new URL('../../../', import.meta.url);

describe.each(TARGETS.map((t) => [t.out, t] as const))('standalone validators in %s', (out, t) => {
  const generated = fileURLToPath(new URL(out, ROOT));

  it('are up to date with the schemas', () => {
    expect(readFileSync(generated, 'utf8')).toBe(generate(t));
  });

  it('load nothing at runtime, so ajv stays a build-time tool', () => {
    expect(runtimeImports(readFileSync(generated, 'utf8'))).toEqual([]);
  });
});

describe('runtimeImports', () => {
  it('flags a runtime helper in generated code (negative control)', () => {
    const code =
      'const func2 = require("ajv/dist/runtime/ucs2length").default;\nexport const x = 1;';
    expect(runtimeImports(code)).toHaveLength(1);
    expect(runtimeImports('import equal from "ajv/dist/runtime/equal";')).toHaveLength(1);
  });

  it('covers the formats and the descriptors', () => {
    expect(TARGETS.map((t) => t.out)).toEqual([
      'src/formats/generated/validators.ts',
      'src/descriptors/generated/validators.ts',
    ]);
  });
});
