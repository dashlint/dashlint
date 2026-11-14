// T11.2a (ADR-045): an SDK client held in an `any` or `unknown` binding makes the described calls
// on it open world, never sites, and an untyped value that never held the SDK gives nothing. The
// fixtures are mini repos with synthetic bookshop names.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDescriptors, type Descriptor } from '../../../src/descriptors/index.js';
import {
  createSourceProgram,
  findSdkCalls,
  followWrappers,
  resolveEventNames,
  type SdkCallScan,
  type SourceProgram,
} from '../../../src/extract/index.js';
import { perMutant } from '../per-mutant.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));

const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors: Descriptor[] = loaded.value;

function program(fixture: string) {
  const r = createSourceProgram({
    repoRoot: join(FIXTURES, fixture),
    source: { name: 'app', path: '.' },
    descriptors,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('posthog-js client in an untyped binding', () => {
  const fixture = perMutant(() => {
    const sp = program('posthog-js/untyped-client');
    const result = findSdkCalls(sp, descriptors);
    return { sp, result, open: result.openWorld.map((o) => `${o.file}:${o.line} ${o.kind}`) };
  });
  let sp: SourceProgram;
  let result: SdkCallScan;
  let open: string[];
  beforeEach(() => {
    ({ sp, result, open } = fixture());
  });

  it('makes calls on a module let filled by a dynamic import() open world', () => {
    expect(open.filter((o) => o.startsWith('src/dynamic.ts'))).toEqual([
      'src/dynamic.ts:12 unresolved-import',
      'src/dynamic.ts:13 unresolved-import',
    ]);
  });

  it('follows Promise.all of dynamic imports, an array parameter and a ?? fallback', () => {
    expect(open.filter((o) => o.startsWith('src/combined.ts'))).toEqual([
      'src/combined.ts:15 unresolved-import',
    ]);
  });

  it('makes calls on a class field filled by new of a required SDK class open world', () => {
    expect(open.filter((o) => o.startsWith('src/field.ts'))).toEqual([
      'src/field.ts:12 unresolved-import',
    ]);
  });

  it('follows a value returned as any, passed to an unknown parameter, destructured, read from a typed property and passed on between bindings', () => {
    expect(open.filter((o) => o.startsWith('src/passed.ts'))).toEqual([
      'src/passed.ts:9 unresolved-import',
      'src/passed.ts:13 unresolved-import',
      'src/passed.ts:20 unresolved-import',
      'src/passed.ts:26 unresolved-import',
      'src/passed.ts:34 unresolved-import',
    ]);
  });

  it('follows an unresolved SDK import assigned after the declaration and an arrow function returning any', () => {
    expect(open.filter((o) => o.startsWith('src/imported.ts'))).toEqual([
      'src/imported.ts:13 unresolved-import',
      'src/imported.ts:19 unresolved-import',
    ]);
  });

  it('reads a JavaScript let with no type filled by require in another function', () => {
    expect(open.filter((o) => o.startsWith('src/legacy.js'))).toEqual([
      'src/legacy.js:10 unresolved-import',
    ]);
  });

  it('names the untyped binding, its type, the package and the member in the reason', () => {
    expect(result.openWorld.find((o) => o.file === 'src/field.ts')?.reason).toBe(
      '`capture` is called on `this.client`, typed `any` but holding a value from "posthog-js", so it may be a posthog-js call',
    );
    expect(result.openWorld.find((o) => o.file === 'src/passed.ts' && o.line === 13)?.reason).toBe(
      '`capture` is called on `client`, typed `unknown` but holding a value from "posthog-js", so it may be a posthog-js call',
    );
  });

  it('negative control: a typed client stays a site; any values that never held the SDK give nothing', () => {
    expect(result.calls.map((c) => `${c.file}:${c.line} ${c.declaration}`)).toEqual([
      'src/negative.ts:16 PostHog.capture',
    ]);
    expect(open.filter((o) => o.startsWith('src/negative.ts'))).toEqual([]);
  });

  it('counts the untyped calls as open sites, so the rate falls below 1', () => {
    const names = resolveEventNames(sp, followWrappers(sp, descriptors));
    expect(names.sites.map((s) => s.names)).toEqual([['book_returned']]);
    expect(names.coverage.openSites).toBe(12);
    expect(names.coverage.nameResolutionRate).toBeLessThan(1);
  });
});

describe('posthog-react-native client in an untyped binding', () => {
  const fixture = perMutant(() => {
    const result = findSdkCalls(program('posthog-react-native/untyped-client'), descriptors);
    return { result, open: result.openWorld.map((o) => `${o.file}:${o.line} ${o.kind}`) };
  });
  let result: SdkCallScan;
  let open: string[];
  beforeEach(() => {
    ({ result, open } = fixture());
  });

  it('makes calls on a required client in a class field and on a client built in import().then open world', () => {
    expect(open).toEqual([
      'src/dynamic.ts:11 unresolved-import',
      'src/field.ts:12 unresolved-import',
      'src/field.ts:16 unresolved-import',
    ]);
    expect(result.openWorld[0]?.reason).toBe(
      '`capture` is called on `client`, typed `any` but holding a value from "posthog-react-native", so it may be a posthog-react-native call',
    );
  });

  it('negative control: a typed client stays a site; an any value that never held the SDK gives nothing', () => {
    expect(result.calls.map((c) => `${c.file}:${c.line}`)).toEqual(['src/negative.ts:9']);
  });
});
