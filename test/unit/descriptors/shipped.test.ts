// The descriptors dashlint ships (T3.1): they load, every member they name is declared in their
// stub, every builtin states its condition, and the stubs resolve real calls for the checker.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  DESCRIPTORS_DIR,
  formatDescriptorErrors,
  loadDescriptors,
} from '../../../src/descriptors/loader.js';
import { type Descriptor, isHook } from '../../../src/descriptors/model.js';
import { readStubSurface } from '../../../src/descriptors/stub.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/descriptors/', import.meta.url));

function shipped(): Descriptor[] {
  const r = loadDescriptors();
  if (!r.ok) throw new Error(formatDescriptorErrors(r.errors).join('\n'));
  return r.value;
}

const descriptors = shipped();
const bySdk = new Map(descriptors.map((d) => [d.sdk, d]));

function descriptorOf(sdk: string): Descriptor {
  const d = bySdk.get(sdk);
  if (!d) throw new Error(`no descriptor for ${sdk}`);
  return d;
}

// The members V1 recorded at the verified versions (notes research/v1-summary.md), as
// `Container.member` (or `hook:name`). A change here needs new V1 evidence.
const V1_SURFACE: Record<string, string[]> = {
  'posthog-js': [
    'PostHog.capture',
    'PostHog.identify',
    'PostHog.people.set',
    'PostHog.people.set_once',
    'PostHog.register',
    'PostHog.register_once',
    'PostHog.reset',
    'PostHog.setPersonProperties',
    'hook:usePostHog',
  ],
  'posthog-react-native': [
    'PostHog.identify',
    'PostHog.register',
    'PostHog.reset',
    'PostHog.screen',
    'PostHog.setPersonProperties',
    'PostHogCore.capture',
    'PostHogCore.identify',
    'PostHogCore.reset',
    'PostHogCore.setPersonProperties',
    'PostHogCoreStateless.register',
    'hook:usePostHog',
  ],
};

function surfaceOf(d: Descriptor): string[] {
  return d.calls
    .flatMap((c) => (isHook(c) ? [`hook:${c.hook}`] : c.on.map((o) => `${o}.${c.member}`)))
    .sort();
}

describe('shipped descriptors', () => {
  it('are the two PostHog SDKs, loaded without errors', () => {
    expect(descriptors.map((d) => d.sdk)).toEqual(['posthog-js', 'posthog-react-native']);
    expect(bySdk.get('posthog-js')?.platforms).toEqual(['web']);
    expect(bySdk.get('posthog-react-native')?.platforms).toEqual(['ios', 'android']);
  });

  it.each(Object.entries(V1_SURFACE))('%s describes exactly the V1 members', (sdk, members) => {
    expect(surfaceOf(descriptorOf(sdk))).toEqual(members);
  });

  describe.each(descriptors.map((d) => [d.sdk, d] as const))('%s', (_, d) => {
    const stubText = readFileSync(d.stub.file, 'utf8');
    const surface = readStubSurface(stubText, d.stub.file);

    it('declares each member in its stub', () => {
      for (const c of d.calls) {
        if (isHook(c)) expect(surface.functions.has(c.hook), c.hook).toBe(true);
        else
          for (const o of c.on)
            expect(surface.containers.get(o)?.has(c.member), `${o}.${c.member}`).toBe(true);
      }
    });

    it('gives each builtin a condition or "always"', () => {
      const all = [...d.builtins.events, ...d.builtins.properties, ...d.builtins.personProperties];
      expect(all.length).toBeGreaterThan(0);
      for (const b of all) {
        const ok =
          b.when === 'always' ||
          ('option' in b.when && ('not' in b.when || 'is' in b.when)) ||
          ('unknown' in b.when && b.when.unknown.trim() !== '');
        expect(ok, b.name).toBe(true);
      }
    });

    it('carries the upstream licence header in its stub', () => {
      expect(stubText).toMatch(/Licensed under the Apache License, Version 2\.0/);
      expect(stubText).toMatch(/MIT License\. Copyright \(c\) 2022 PostHog/);
      expect(stubText).toContain('Modified by dashlint');
    });

    it('keeps its files inside descriptors/', () => {
      expect(d.file.startsWith(DESCRIPTORS_DIR)).toBe(true);
      expect(d.stub.file.startsWith(join(DESCRIPTORS_DIR, 'stubs'))).toBe(true);
    });
  });

  it('marks the lifecycle events of posthog-react-native with their init option', () => {
    const events = descriptorOf('posthog-react-native').builtins.events;
    const lifecycle = events.filter((e) => e.name.startsWith('Application '));
    expect(lifecycle).toHaveLength(5);
    for (const e of lifecycle)
      expect(e.when).toEqual({ option: 'captureAppLifecycleEvents', not: false });
  });

  // ADR-012, ADR-029: PostHog's GeoIP transformation, cited in notes/research/t39-ingestion.md.
  it.each(descriptors.map((d) => [d.sdk, d] as const))(
    '%s carries the $geoip_* ingestion rows, each unknown',
    (_, d) => {
      const geo = (list: { name: string }[]) =>
        list.map((b) => b.name).filter((n) => n.startsWith('$geoip_'));
      expect(geo(d.builtins.properties)).toHaveLength(14);
      expect(geo(d.builtins.personProperties)).toHaveLength(15);
      expect(geo(d.builtins.events)).toEqual([]);
      const country = d.builtins.properties.find((p) => p.name === '$geoip_country_code');
      expect(country).toMatchObject({ events: '*', presence: 'sometimes' });
      for (const b of [...d.builtins.properties, ...d.builtins.personProperties])
        if (b.name.startsWith('$geoip_'))
          expect(b.when, b.name).toEqual({ unknown: expect.stringContaining('GeoIP') });
    },
  );
});

// Resolves each call in the fixture app through the checker with the stub as the only source of
// the SDK's types: the declaration must be in the stub, on the container the descriptor names.
function resolvedCalls(
  d: Descriptor,
  fixture: string,
): { call: string; container: string; file: string }[] {
  const app = join(FIXTURES, fixture);
  const program = ts.createProgram([d.stub.file, app], {
    noEmit: true,
    strict: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map((x) => ts.flattenDiagnosticMessageText(x.messageText, '\n'));
  expect(diagnostics).toEqual([]);
  const checker = program.getTypeChecker();
  const out: { call: string; container: string; file: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const decl = checker.getResolvedSignature(node)?.declaration;
      if (decl) {
        // A member typed as a function (`set: (...) => void`) declares its signature on a function
        // type whose parent is the member itself; start above it.
        let owner: ts.Node | undefined = ts.isFunctionTypeNode(decl)
          ? decl.parent.parent
          : decl.parent;
        const path: string[] = [];
        while (owner && !ts.isClassDeclaration(owner) && !ts.isModuleBlock(owner)) {
          if (ts.isPropertySignature(owner) || ts.isPropertyDeclaration(owner))
            path.unshift(owner.name.getText());
          owner = owner.parent;
        }
        const container =
          owner && ts.isClassDeclaration(owner) && owner.name
            ? [owner.name.text, ...path].join('.')
            : '-';
        out.push({
          call: node.expression.getText(),
          container,
          file: decl.getSourceFile().fileName,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  const source = program.getSourceFile(app);
  if (!source) throw new Error(`no source file ${app}`);
  visit(source);
  return out;
}

// Each case type-checks a program against the stub (5 to 7 s under coverage on a busy machine).
describe('stubs resolve calls when the package is not installed', { timeout: 30000 }, () => {
  it('posthog-js', () => {
    const d = descriptorOf('posthog-js');
    const calls = resolvedCalls(d, 'posthog-js-app.ts');
    for (const c of calls) expect(c.file).toBe(d.stub.file.replace(/\\/g, '/'));
    expect(calls.map((c) => `${c.call} -> ${c.container}`)).toEqual([
      'posthog.capture -> PostHog',
      'posthog.register -> PostHog',
      'posthog.register_once -> PostHog',
      'posthog.identify -> PostHog',
      'posthog.setPersonProperties -> PostHog',
      'posthog.people.set -> PostHog.people',
      'posthog.people.set_once -> PostHog.people',
      'posthog.reset -> PostHog',
      'second.capture -> PostHog',
      'usePostHog -> -',
      'client.capture -> PostHog',
    ]);
  });

  it('posthog-react-native, with capture on the base class', () => {
    const d = descriptorOf('posthog-react-native');
    const calls = resolvedCalls(d, 'posthog-react-native-app.ts');
    for (const c of calls) expect(c.file).toBe(d.stub.file.replace(/\\/g, '/'));
    expect(calls.map((c) => `${c.call} -> ${c.container}`)).toEqual([
      'posthog.capture -> PostHogCore',
      'posthog.screen -> PostHog',
      'posthog.register -> PostHog',
      'posthog.identify -> PostHog',
      'posthog.setPersonProperties -> PostHog',
      'posthog.reset -> PostHog',
      'usePostHog -> -',
      'client.capture -> PostHogCore',
    ]);
  });
});
