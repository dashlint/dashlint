// T3.3: SDK calls are matched by their resolved declaration, never by identifier (spec 6.4 item
// 3), and a callee from an SDK import that does not resolve is open world (G15). The fixtures are
// mini repos with synthetic bookshop names.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadDescriptors,
  matchMember,
  memberKey,
  PackageResolver,
  packageName,
  type Descriptor,
} from '../../../src/descriptors/index.js';
import { createSourceProgram, findSdkCalls, type SdkCallScan } from '../../../src/extract/index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));

const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors: Descriptor[] = loaded.value;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function temp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dashlint-calls-'));
  temps.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function scan(repoRoot: string, using: Descriptor[] = descriptors): SdkCallScan {
  const r = createSourceProgram({ repoRoot, source: { name: 'app', path: '.' }, descriptors });
  if (!r.ok) throw new Error(r.error);
  return findSdkCalls(r.value, using);
}

// `file:line Container.member sdk role`, one per matched call.
function sites(s: SdkCallScan): string[] {
  return s.calls.map((c) => {
    const e = c.entry;
    const role = e.event
      ? 'event'
      : e.superProperties
        ? 'super'
        : e.identity
          ? `identity:${e.identity}`
          : 'person';
    return `${c.file}:${c.line} ${c.declaration} ${c.descriptor.sdk} ${role}`;
  });
}

function open(s: SdkCallScan): string[] {
  return s.openWorld.map((o) => `${o.file}:${o.line} ${o.kind}`);
}

describe('posthog-js calls by declaration (stub)', () => {
  const result = scan(join(FIXTURES, 'posthog-js/calls'));

  it('matches direct calls with the entry for each member, on the line of the called name', () => {
    expect(sites(result).filter((s) => s.startsWith('src/direct.ts'))).toEqual([
      'src/direct.ts:5 PostHog.capture posthog-js event',
      'src/direct.ts:9 PostHog.identify posthog-js identity:identify',
      'src/direct.ts:10 PostHog.register posthog-js super',
      'src/direct.ts:11 PostHog.register_once posthog-js super',
      'src/direct.ts:12 PostHog.setPersonProperties posthog-js person',
      'src/direct.ts:13 PostHog.people.set posthog-js person',
      'src/direct.ts:14 PostHog.people.set_once posthog-js person',
      'src/direct.ts:20 PostHog.reset posthog-js identity:reset',
    ]);
  });

  it('follows an aliased import, a const alias and a bound method to the same declaration', () => {
    expect(sites(result).filter((s) => s.startsWith('src/aliased.ts'))).toEqual([
      'src/aliased.ts:8 PostHog.capture posthog-js event',
      'src/aliased.ts:9 PostHog.capture posthog-js event',
      'src/aliased.ts:10 PostHog.capture posthog-js event',
    ]);
  });

  it('matches members destructured from usePostHog(), renamed or not, and called on its result', () => {
    expect(sites(result).filter((s) => s.startsWith('src/hook.ts'))).toEqual([
      'src/hook.ts:7 PostHog.capture posthog-js event',
      'src/hook.ts:8 PostHog.capture posthog-js event',
      'src/hook.ts:9 PostHog.capture posthog-js event',
    ]);
  });

  it('negative control: a local function and a local class named like the SDK give no site', () => {
    expect(sites(result).filter((s) => s.startsWith('src/local.ts'))).toEqual([]);
    expect(open(result).filter((s) => s.startsWith('src/local.ts'))).toEqual([]);
  });

  it('makes a described call on an unresolved SDK import open world, with the reason', () => {
    expect(sites(result).filter((s) => s.startsWith('src/unresolved.ts'))).toEqual([]);
    expect(result.openWorld).toEqual([
      {
        file: 'src/unresolved.ts',
        line: 8,
        kind: 'unresolved-import',
        reason:
          '`capture` comes from "posthog-js/dist/module.no-external", which does not resolve, so it may be a posthog-js call',
      },
    ]);
  });

  it('keeps the call node for the later stages', () => {
    const first = result.calls.find((c) => c.file === 'src/direct.ts');
    expect(first && ts.isCallExpression(first.call)).toBe(true);
    expect(first?.call.arguments[0]?.getText()).toBe("'book_shelved'");
    expect(result.calls.map((c) => c.file)).toEqual([...result.calls.map((c) => c.file)].sort());
  });
});

describe('posthog-react-native calls by declaration (stub)', () => {
  const result = scan(join(FIXTURES, 'posthog-react-native/calls'));

  it('matches an inherited member on the base container and the subclass own members', () => {
    expect(sites(result).filter((s) => s.startsWith('src/direct.ts'))).toEqual([
      'src/direct.ts:7 PostHogCore.capture posthog-react-native event',
      'src/direct.ts:8 PostHog.screen posthog-react-native event',
      'src/direct.ts:12 PostHog.identify posthog-react-native identity:identify',
      'src/direct.ts:13 PostHog.register posthog-react-native super',
      'src/direct.ts:14 PostHog.setPersonProperties posthog-react-native person',
      'src/direct.ts:15 PostHog.reset posthog-react-native identity:reset',
    ]);
  });

  it('follows an aliased import and a value typed by the base class', () => {
    expect(sites(result).filter((s) => s.startsWith('src/aliased.ts'))).toEqual([
      'src/aliased.ts:8 PostHogCore.capture posthog-react-native event',
      'src/aliased.ts:9 PostHogCore.capture posthog-react-native event',
    ]);
  });

  it('matches members destructured from usePostHog()', () => {
    expect(sites(result).filter((s) => s.startsWith('src/hook.ts'))).toEqual([
      'src/hook.ts:6 PostHogCore.capture posthog-react-native event',
      'src/hook.ts:7 PostHog.screen posthog-react-native event',
    ]);
  });

  it('negative control: a local arrow function and a local object method give no site', () => {
    expect(sites(result).filter((s) => s.startsWith('src/local.ts'))).toEqual([]);
  });

  it('makes the renamed member of an unresolved hook open world under its described name', () => {
    expect(result.openWorld).toEqual([
      {
        file: 'src/unresolved.ts',
        line: 6,
        kind: 'unresolved-import',
        reason:
          '`capture` comes from "posthog-react-native/lib/commonjs/hooks", which does not resolve, so it may be a posthog-react-native call',
      },
    ]);
  });
});

describe('installed types', () => {
  it('matches a member declared in a scoped declaredIn package and not a same-named decoy', () => {
    const result = scan(join(FIXTURES, 'posthog-react-native/installed'));
    expect(sites(result)).toEqual([
      'src/loans.ts:8 PostHogCore.capture posthog-react-native event',
      'src/loans.ts:9 PostHog.screen posthog-react-native event',
    ]);
    expect(result.openWorld).toEqual([]);
  });

  it('matches posthog-js from node_modules', () => {
    expect(sites(scan(join(FIXTURES, 'posthog-js/installed')))).toEqual([
      'src/shelf.ts:4 PostHog.capture posthog-js event',
    ]);
  });

  it('matches a member in a declaredIn package the source does not import directly', () => {
    const root = temp({
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "moduleResolution": "bundler" } }',
      'node_modules/@posthog/types/package.json':
        '{ "name": "@posthog/types", "version": "1.424.1", "types": "index.d.ts" }',
      'node_modules/@posthog/types/index.d.ts':
        'export interface PostHog { capture(event: string): void; }\n',
      'src/window.ts': [
        "import type { PostHog } from '@posthog/types';",
        'declare const posthog: PostHog;',
        "posthog.capture('basket_opened');",
        '',
      ].join('\n'),
    });
    expect(sites(scan(root))).toEqual(['src/window.ts:3 PostHog.capture posthog-js event']);
  });

  it('matches only against the descriptors it is given', () => {
    const rn = descriptors.filter((d) => d.sdk === 'posthog-react-native');
    expect(sites(scan(join(FIXTURES, 'posthog-js/installed'), rn))).toEqual([]);
  });
});

describe('declarations in user code', () => {
  it('matches a typed-events augmentation of the SDK module', () => {
    const root = temp({
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "moduleResolution": "bundler" } }',
      'src/events.ts': [
        "import posthog from 'posthog-js';",
        "declare module 'posthog-js' {",
        '  interface PostHog {',
        "    capture(event_name: 'order_placed', properties: { total: number }): undefined;",
        '  }',
        '}',
        "posthog.capture('order_placed', { total: 12 });",
        '',
      ].join('\n'),
    });
    expect(sites(scan(root))).toEqual(['src/events.ts:7 PostHog.capture posthog-js event']);
  });

  it('negative control: a declaration file of the source with SDK names is not the SDK', () => {
    const root = temp({
      'package.json': '{ "name": "bookshop-web" }',
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "moduleResolution": "bundler" } }',
      'src/analytics.d.ts': 'export declare class PostHog { capture(event: string): void }\n',
      'src/cart.ts': [
        "import { PostHog } from './analytics';",
        "new PostHog().capture('cart_saved');",
        '',
      ].join('\n'),
    });
    const result = scan(root);
    expect(sites(result)).toEqual([]);
    expect(result.openWorld).toEqual([]);
  });

  it('negative control: code of a repository whose package is named like the SDK is not the SDK', () => {
    const root = temp({
      'package.json': '{ "name": "posthog-js" }',
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "moduleResolution": "bundler" } }',
      'src/core.ts': [
        'export class PostHog {',
        '  capture(event: string): string {',
        '    return event;',
        '  }',
        '}',
        "new PostHog().capture('internal_ping');",
        '',
      ].join('\n'),
    });
    expect(sites(scan(root))).toEqual([]);
  });

  it('negative control: a member the descriptor does not describe is not a site', () => {
    const root = temp({
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "moduleResolution": "bundler" } }',
      'src/group.ts': [
        "import posthog from 'posthog-js';",
        "posthog.group('company', 'bookshop');",
        "posthog.init('demo-token');",
        '',
      ].join('\n'),
    });
    expect(sites(scan(root))).toEqual([]);
  });
});

describe('unresolved SDK imports (open world)', () => {
  const config = '{ "compilerOptions": { "strict": true, "moduleResolution": "bundler" } }';

  it('follows a re-export from a local module and a require in JavaScript', () => {
    const root = temp({
      'tsconfig.json': config,
      'src/lib/client.ts': "export { default as shop } from 'posthog-js/lite';\n",
      'src/lib/index.ts': "export * from './client';\nexport { shop as client } from './client';\n",
      'src/order.ts': ["import { client } from './lib';", "client.capture('order_paid');", ''].join(
        '\n',
      ),
      'src/legacy.js': [
        "const lite = require('posthog-js/lite');",
        "lite.register({ till: 'front' });",
        '',
      ].join('\n'),
    });
    expect(open(scan(root))).toEqual([
      'src/legacy.js:2 unresolved-import',
      'src/order.ts:2 unresolved-import',
    ]);
  });

  it('negative control: a resolved require, an any-typed callee and a non-SDK import are not open world', () => {
    const root = temp({
      'tsconfig.json': config,
      'src/resolved.js': [
        "const { posthog } = require('posthog-js');",
        "posthog.capture('receipt_printed');",
        '',
      ].join('\n'),
      'src/any.ts': [
        'declare const window: { posthog: any };',
        "window.posthog.capture('receipt_emailed');",
        "import { reset } from 'till-kit';",
        'reset();',
        '',
      ].join('\n'),
    });
    const result = scan(root);
    expect(sites(result)).toEqual(['src/resolved.js:2 PostHog.capture posthog-js event']);
    expect(result.openWorld).toEqual([]);
  });

  it('reads element access and import-equals forms', () => {
    const root = temp({
      'tsconfig.json':
        '{ "compilerOptions": { "strict": true, "module": "commonjs", "moduleResolution": "node10" } }',
      'src/till.ts': [
        "import posthog = require('posthog-js');",
        "import lite = require('posthog-js/lite');",
        "posthog.posthog['capture']('till_opened');",
        "lite['capture']('till_closed');",
        "lite[String('reset')]();",
        "(posthog.posthog as posthog.PostHog)!.capture('till_counted');",
        "(lite!).identify('cashier-2');",
        '',
      ].join('\n'),
    });
    const result = scan(root);
    expect(sites(result)).toEqual([
      'src/till.ts:3 PostHog.capture posthog-js event',
      'src/till.ts:6 PostHog.capture posthog-js event',
    ]);
    expect(open(result)).toEqual([
      'src/till.ts:4 unresolved-import',
      'src/till.ts:7 unresolved-import',
    ]);
  });

  it('flags every described member, not only event members', () => {
    const root = temp({
      'tsconfig.json': config,
      'src/a.ts': "import ph from 'posthog-js/x';\nph.identify('reader-1');\n",
    });
    expect(scan(root).openWorld.map((o) => o.reason)).toEqual([
      '`identify` comes from "posthog-js/x", which does not resolve, so it may be a posthog-js call',
    ]);
  });
});

describe('match helpers', () => {
  it('names the package of a specifier', () => {
    expect(packageName('posthog-js/react')).toBe('posthog-js');
    expect(packageName('@posthog/core/dist/x')).toBe('@posthog/core');
    expect(packageName('@posthog')).toBeUndefined();
    expect(packageName('./analytics')).toBeUndefined();
    expect(packageName('/abs/analytics')).toBeUndefined();
    expect(packageName('')).toBeUndefined();
  });

  it('finds the package of a declaration file by node_modules or the nearest package.json', () => {
    const root = temp({
      'packages/kit/package.json': '{ "name": "@bookshop/kit" }',
      'packages/kit/dist/types/index.d.ts': '',
      'packages/broken/package.json': '{ not json',
      'packages/broken/index.d.ts': '',
    });
    const r = new PackageResolver();
    expect(r.packageOf('/x/node_modules/.pnpm/a@1/node_modules/@posthog/core/dist/a.d.ts')).toBe(
      '@posthog/core',
    );
    expect(r.packageOf(join(root, 'packages/kit/dist/types/index.d.ts'))).toBe('@bookshop/kit');
    expect(r.packageOf(join(root, 'packages/kit/dist/types/index.d.ts'))).toBe('@bookshop/kit');
    expect(r.packageOf(join(root, 'packages/broken/index.d.ts'))).toBeUndefined();
  });

  it('keys members of classes, interfaces, type aliases and object-typed properties', () => {
    const sf = ts.createSourceFile(
      'k.d.ts',
      [
        'declare class A { m(): void; p: { q: () => void }; f: () => void }',
        'interface B { m(): void }',
        'type C = { m(): void; n: (x: string) => void };',
        'declare function free(): void;',
        'declare const o: { [k: string]: { r(): void } };',
        'declare class D { ["computed"](): void; [k: string]: unknown }',
        'declare const E: { new (): { m(): void } };',
        'function outer() { function inner() {} }',
        'declare module "m" { function track(): void; namespace N { function deep(): void } }',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );
    const keys: string[] = [];
    const visit = (n: ts.Node): void => {
      const k = memberKey(n);
      if (k) keys.push(`${k.container}.${k.member}`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    // A computed name, an index signature's member and a construct signature's result have no key;
    // a module-level function (in a file or a `declare module` block) is on `(module)` (ADR-054),
    // a function inside a function body or a namespace is not.
    expect(keys).toEqual([
      'A.m',
      'A.p.q',
      'A.f',
      'B.m',
      'C.m',
      'C.n',
      '(module).free',
      '(module).outer',
      '(module).track',
    ]);
  });

  it('matches only a declaredIn package with the member on a listed container', () => {
    const js = descriptors.filter((d) => d.sdk === 'posthog-js');
    expect(
      matchMember(js, 'posthog-js', { container: 'PostHog', member: 'capture' })?.declaration,
    ).toBe('PostHog.capture');
    expect(
      matchMember(js, '@posthog/types', { container: 'PostHog', member: 'capture' }),
    ).toBeDefined();
    expect(
      matchMember(js, 'posthog-js', { container: 'PostHogCore', member: 'capture' }),
    ).toBeUndefined();
    expect(
      matchMember(js, 'shelf-analytics', { container: 'PostHog', member: 'capture' }),
    ).toBeUndefined();
    expect(
      matchMember(js, 'posthog-js', { container: 'PostHog', member: 'usePostHog' }),
    ).toBeUndefined();
  });
});
