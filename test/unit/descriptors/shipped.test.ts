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
// mixpanel-browser's track_links and track_forms are cited from its src/index.d.ts (lines 503, 508,
// 595, 600) by T4.2 (ADR-054); `(module)` is a module-level function.
const MIXPANEL_BROWSER_SHARED = [
  'identify',
  'register',
  'register_once',
  'reset',
  'track',
  'track_forms',
  'track_links',
  'track_with_groups',
];
// Amplitude (T4.3, ADR-055): V1's rows less groupIdentify and setGroup (group calls, as for
// Mixpanel) and Identify's add, append and unset; `(module)` is a module-level const.
const AMPLITUDE_EVENTS = ['logEvent', 'track'];
const amplitude = (client: string, extra: string[]) =>
  [
    ...[...AMPLITUDE_EVENTS, 'identify', 'reset', 'setUserId', ...extra].map(
      (m) => `(module).${m}`,
    ),
    ...[...AMPLITUDE_EVENTS, 'identify'].map((m) => `AmplitudeCore.${m}`),
    ...[...AMPLITUDE_EVENTS, 'identify'].map((m) => `CoreClient.${m}`),
    'Client.reset',
    'Client.setUserId',
    ...['identify', 'reset', 'setUserId', ...extra].map((m) => `${client}.${m}`),
    'IIdentify.set',
    'IIdentify.setOnce',
    'Identify.set',
    'Identify.setOnce',
  ].sort();
const AMPLITUDE_SCREEN = ['trackScreenView', 'trackScreenViewOnNavigationStateChange'];
// Segment (T4.4, ADR-056): V1's rows less page, screen (a destination names them), group, alias,
// register (plugins, never super properties) and addSourceMiddleware; the link and form helpers
// are cited from analytics-next's dist/types/core/analytics/index.d.ts:61-64 and
// core/buffer/index.d.ts:78-80, where AnalyticsBuffered has no trackForm.
const SEGMENT_HELPERS = ['trackClick', 'trackLink', 'trackSubmit'];
const SEGMENT_SURFACE = {
  'segment-analytics-next': [
    ...['identify', 'reset', 'track', 'trackForm', ...SEGMENT_HELPERS].map((m) => `Analytics.${m}`),
    ...['identify', 'track'].map((m) => `AnalyticsCore.${m}`),
    ...['identify', 'reset', 'track', ...SEGMENT_HELPERS].map((m) => `AnalyticsBuffered.${m}`),
  ].sort(),
  'segment-analytics-react-native': [
    ...['identify', 'reset', 'track'].map((m) => `SegmentClient.${m}`),
    ...['identify', 'reset', 'track'].map((m) => `ClientMethods.${m}`),
    'hook:useAnalytics',
  ].sort(),
};
const V1_SURFACE: Record<string, string[]> = {
  ...SEGMENT_SURFACE,
  'amplitude-browser': amplitude('AmplitudeBrowserLite', []),
  'amplitude-react-native': [
    ...amplitude('AmplitudeReactNative', AMPLITUDE_SCREEN),
    ...AMPLITUDE_SCREEN.map((m) => `ReactNativeClient.${m}`),
  ].sort(),
  'mixpanel-browser': [
    ...MIXPANEL_BROWSER_SHARED.map((m) => `(module).${m}`),
    ...MIXPANEL_BROWSER_SHARED.map((m) => `Mixpanel.${m}`),
    'Mixpanel.track_pageview',
    'People.set',
    'People.set_once',
  ].sort(),
  'mixpanel-react-native': [
    'Mixpanel.identify',
    'Mixpanel.registerSuperProperties',
    'Mixpanel.registerSuperPropertiesOnce',
    'Mixpanel.reset',
    'Mixpanel.track',
    'Mixpanel.trackWithGroups',
    'People.set',
    'People.setOnce',
  ],
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
  it('are the PostHog, Mixpanel, Amplitude and Segment SDKs, loaded without errors', () => {
    expect(descriptors.map((d) => d.sdk)).toEqual([
      'amplitude-browser',
      'amplitude-react-native',
      'mixpanel-browser',
      'mixpanel-react-native',
      'posthog-js',
      'posthog-react-native',
      'segment-analytics-next',
      'segment-analytics-react-native',
    ]);
    expect(bySdk.get('segment-analytics-next')?.platforms).toEqual(['web']);
    expect(bySdk.get('segment-analytics-react-native')?.platforms).toEqual(['ios', 'android']);
    expect(bySdk.get('posthog-js')?.platforms).toEqual(['web']);
    expect(bySdk.get('posthog-react-native')?.platforms).toEqual(['ios', 'android']);
    expect(bySdk.get('mixpanel-browser')?.platforms).toEqual(['web']);
    expect(bySdk.get('mixpanel-react-native')?.platforms).toEqual(['ios', 'android']);
    expect(bySdk.get('amplitude-browser')?.platforms).toEqual(['web']);
    expect(bySdk.get('amplitude-react-native')?.platforms).toEqual(['ios', 'android']);
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
      if (d.sdk.startsWith('amplitude-')) {
        expect(stubText).toMatch(/MIT License\. Copyright \(c\) 2022 Amplitude Analytics\./);
        expect(stubText).toMatch(/The above copyright notice\s+\/\/ and this permission notice/);
      } else if (d.sdk.startsWith('segment-')) {
        expect(stubText).toMatch(/MIT License(?: \(MIT\))?\. Copyright \(c\) 202[01] Segment\./);
        expect(stubText).toMatch(/The above copyright notice\s+\/\/ and this permission notice/);
      } else {
        expect(stubText).toMatch(/Licensed under the Apache License, Version 2\.0/);
        if (d.sdk.startsWith('posthog-'))
          expect(stubText).toMatch(/MIT License\. Copyright \(c\) 2022 PostHog/);
        else expect(stubText).toMatch(/Copyright 20\d\d Mixpanel, Inc\./);
      }
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
  const posthog = descriptors.filter((d) => d.sdk.startsWith('posthog-'));
  it.each(posthog.map((d) => [d.sdk, d] as const))(
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

  it('keeps PostHog ingestion rows out of the Mixpanel builtins', () => {
    for (const sdk of ['mixpanel-browser', 'mixpanel-react-native']) {
      const b = descriptorOf(sdk).builtins;
      const names = [...b.events, ...b.properties, ...b.personProperties].map((x) => x.name);
      expect(
        names.filter((n) => n.startsWith('$geoip_')),
        sdk,
      ).toEqual([]);
      expect(descriptorOf(sdk).unknownNames?.events, sdk).toEqual(['$']);
    }
  });

  // research/v2-mixpanel.md lead review: an object config switches autocapture on (`is: true`),
  // track_marketing is on unless false, and the page view has no decidable option.
  it('gives the mixpanel-browser autocapture, marketing and page view rows their conditions', () => {
    const b = descriptorOf('mixpanel-browser').builtins;
    const when = (name: string) =>
      [...b.events, ...b.properties].find((x) => x.name === name)?.when;
    expect(when('$mp_click')).toEqual({ option: 'autocapture', is: true });
    expect(when('utm_source')).toEqual({ option: 'track_marketing', not: false });
    expect(when('$mp_web_page_view')).toEqual({ unknown: expect.stringContaining('default off') });
    expect(when('$mp_page_leave')).toEqual({ unknown: expect.stringContaining('page_leave') });
    expect(descriptorOf('mixpanel-react-native').builtins.events).toEqual([]);
  });

  // ADR-055: the V2 drafts name an autocapture key by its last segment; the option an init call
  // writes is `autocapture.<key>`, and React Native sessions depend on two options.
  it('reads the Amplitude autocapture switches under `autocapture`', () => {
    const when = (sdk: string, name: string) => {
      const b = descriptorOf(sdk).builtins;
      return [...b.events, ...b.properties, ...b.personProperties].find((x) => x.name === name)
        ?.when;
    };
    expect(when('amplitude-browser', '[Amplitude] Page Viewed')).toEqual({
      option: 'autocapture.pageViews',
      not: false,
    });
    expect(when('amplitude-browser', '[Amplitude] Element Clicked')).toEqual({
      option: 'autocapture.elementInteractions',
      is: true,
    });
    expect(when('amplitude-browser', 'gclid')).toEqual({
      option: 'autocapture.attribution',
      not: false,
    });
    expect(when('amplitude-browser', 'platform')).toEqual({
      option: 'trackingOptions.platform',
      not: false,
    });
    expect(when('amplitude-react-native', '[Amplitude] Application Opened')).toEqual({
      option: 'autocapture.appLifecycles',
      is: true,
    });
    expect(when('amplitude-react-native', 'session_start')).toEqual({
      unknown: expect.stringContaining('trackingSessionEvents'),
    });
    for (const sdk of ['amplitude-browser', 'amplitude-react-native']) {
      const b = descriptorOf(sdk).builtins;
      const options = [...b.events, ...b.properties, ...b.personProperties].flatMap((x) =>
        typeof x.when === 'object' && 'option' in x.when ? [x.when.option] : [],
      );
      expect(
        options.filter((o) => !o.includes('.')),
        sdk,
      ).toEqual([]);
    }
  });

  // ADR-056: Segment's React Native lifecycle and deep-link events are off unless switched on
  // (src/analytics.ts:583, 760, 812); the browser SDK sends no event of its own, and context
  // fields are unknown on every event (a destination maps them), each name once.
  it('gives the Segment builtins their conditions, with context fields unknown', () => {
    const rn = descriptorOf('segment-analytics-react-native').builtins;
    expect(rn.events.map((e) => [e.name, e.when])).toEqual([
      ['Application Installed', { option: 'trackAppLifecycleEvents', is: true }],
      ['Application Updated', { option: 'trackAppLifecycleEvents', is: true }],
      ['Application Opened', { option: 'trackAppLifecycleEvents', is: true }],
      ['Application Backgrounded', { option: 'trackAppLifecycleEvents', is: true }],
      ['Deep Link Opened', { option: 'trackDeepLinks', is: true }],
    ]);
    const next = descriptorOf('segment-analytics-next').builtins;
    expect(next.events).toEqual([]);
    expect(next.properties.map((p) => p.name)).toEqual([
      'path',
      'referrer',
      'search',
      'title',
      'url',
      'userAgent',
      'library',
      'campaign',
    ]);
    for (const p of next.properties) {
      expect(p.events, p.name).toBe('*');
      expect(p.when, p.name).toEqual({ unknown: expect.any(String) });
    }
    for (const name of ['app', 'device', 'os', 'screen', 'timezone'])
      expect(rn.properties.find((p) => p.name === name)?.when, name).toEqual({
        unknown: expect.stringContaining('context field'),
      });
  });
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
        const named = (n: ts.Node) => ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n);
        while (owner && !named(owner) && !ts.isModuleBlock(owner)) {
          if (ts.isPropertySignature(owner) || ts.isPropertyDeclaration(owner))
            path.unshift(owner.name.getText());
          owner = owner.parent;
        }
        const container =
          owner && (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) && owner.name
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

  it('mixpanel-browser, default export, namespace and named imports', () => {
    const d = descriptorOf('mixpanel-browser');
    const calls = resolvedCalls(d, 'mixpanel-browser-app.ts');
    for (const c of calls) expect(c.file).toBe(d.stub.file.replace(/\\/g, '/'));
    // `-` is a module-level function, which the extractor keys as `(module)`.
    expect(calls.map((c) => `${c.call} -> ${c.container}`)).toEqual([
      'mixpanel.init -> OverridedMixpanel',
      'mixpanel.track -> Mixpanel',
      'mixpanel.track_with_groups -> Mixpanel',
      'mixpanel.track_pageview -> Mixpanel',
      'mixpanel.track_links -> Mixpanel',
      'mixpanel.register -> Mixpanel',
      'mixpanel.identify -> Mixpanel',
      'mixpanel.people.set -> People',
      'mixpanel.people.set_once -> People',
      'mixpanel.reset -> Mixpanel',
      'ns.track -> -',
      'ns.register_once -> -',
      'ns.people.set -> People',
      'track -> -',
      'mixpanel.init -> OverridedMixpanel',
      'second.track -> Mixpanel',
    ]);
  });

  it('mixpanel-react-native, with people through getPeople()', () => {
    const d = descriptorOf('mixpanel-react-native');
    const calls = resolvedCalls(d, 'mixpanel-react-native-app.ts');
    for (const c of calls) expect(c.file).toBe(d.stub.file.replace(/\\/g, '/'));
    expect(calls.map((c) => `${c.call} -> ${c.container}`)).toEqual([
      'mixpanel.init -> Mixpanel',
      'mixpanel.track -> Mixpanel',
      'mixpanel.trackWithGroups -> Mixpanel',
      'mixpanel.registerSuperProperties -> Mixpanel',
      'mixpanel.registerSuperPropertiesOnce -> Mixpanel',
      'mixpanel.identify -> Mixpanel',
      'mixpanel.getPeople().set -> People',
      'mixpanel.getPeople -> Mixpanel',
      'mixpanel.getPeople().setOnce -> People',
      'mixpanel.getPeople -> Mixpanel',
      'mixpanel.reset -> Mixpanel',
      'Mixpanel.init -> Mixpanel',
      'other.track -> Mixpanel',
    ]);
  });
});
