import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import {
  createSourceProgram,
  evaluateCondition,
  followWrappers,
  resolveBuiltins,
  sitePlatforms,
  suffixPlatforms,
  type BuiltinScan,
  type InitSite,
  type OptionValue,
  type SourceProgram,
} from '../../../src/extract/index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;

function program(repo: string): SourceProgram {
  const r = createSourceProgram({
    repoRoot: join(FIXTURES, repo),
    source: { name: 'app', path: '.' },
    descriptors,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const builtins = (repo: string): BuiltinScan => resolveBuiltins(program(repo));

const LIFECYCLE = [
  'Application Backgrounded',
  'Application Became Active',
  'Application Installed',
  'Application Opened',
  'Application Updated',
];

function lifecycleState(scan: BuiltinScan): 'sent' | 'off' | 'conditional' | 'mixed' {
  const states = LIFECYCLE.map((n) =>
    scan.builtins.events.includes(n)
      ? 'sent'
      : scan.off.includes(n)
        ? 'off'
        : scan.builtins.conditional.includes(n)
          ? 'conditional'
          : 'missing',
  );
  const first = states[0];
  return states.every((s) => s === first) && first !== 'missing' && first !== undefined
    ? first
    : 'mixed';
}

describe('resolveBuiltins: the lifecycle builtin (spec 6.3.3, F10)', () => {
  it('option on: the five lifecycle events are sent', () => {
    const scan = builtins('posthog-react-native/lifecycle-on');
    expect(lifecycleState(scan)).toBe('sent');
    expect(scan.inits).toHaveLength(1);
  });

  it('negative control: captureAppLifecycleEvents false removes the lifecycle builtins', () => {
    const scan = builtins('posthog-react-native/lifecycle-off');
    expect(lifecycleState(scan)).toBe('off');
    for (const name of LIFECYCLE) {
      expect(scan.builtins.events).not.toContain(name);
      expect(scan.builtins.conditional).not.toContain(name);
    }
  });

  it('option unresolvable: the lifecycle events are conditional, never "not sent"', () => {
    const scan = builtins('posthog-react-native/lifecycle-unresolvable');
    expect(lifecycleState(scan)).toBe('conditional');
    expect(scan.off).toEqual([]);
  });

  it('no init in the source: every option-conditioned builtin is conditional', () => {
    const scan = builtins('posthog-react-native/lifecycle-none');
    expect(scan.inits).toEqual([]);
    expect(lifecycleState(scan)).toBe('conditional');
    expect(scan.builtins.conditional).toContain('$identify');
    expect(scan.off).toEqual([]);
  });

  it('a provider reads its options prop through a const alias; one given a client is not an init', () => {
    const scan = builtins('posthog-react-native/lifecycle-provider');
    expect(scan.inits.map((i) => i.line)).toEqual([9, 15]);
    expect(lifecycleState(scan)).toBe('off');
  });

  it('a constructor with no options keeps every default', () => {
    const scan = builtins('posthog-react-native/people');
    expect(lifecycleState(scan)).toBe('sent');
    expect(scan.builtins.events).toContain('$identify');
  });
});

describe('resolveBuiltins: the catalog fields', () => {
  it('names the builtins table and keeps always-sent properties out of conditional', () => {
    const scan = builtins('posthog-react-native/lifecycle-on');
    expect(scan.builtins.properties).toBe('posthog-react-native@4');
    expect(scan.properties.map((p) => p.name)).toContain('$lib');
    expect(scan.builtins.conditional).toContain('$app_version');
    expect(scan.builtins.conditional).not.toContain('$lib');
  });

  it('$screen and $autocapture on React Native depend on the provider, so stay conditional', () => {
    const scan = builtins('posthog-react-native/lifecycle-on');
    expect(scan.builtins.conditional).toEqual(expect.arrayContaining(['$autocapture', '$screen']));
  });

  it('posthog-js init: false turns a builtin off, an object or string keeps it, is:true needs it set', () => {
    const scan = builtins('posthog-js/super');
    expect(scan.inits).toHaveLength(1);
    expect(scan.off).toContain('$pageview');
    expect(scan.builtins.events).toEqual(
      expect.arrayContaining(['$autocapture', '$identify', '$pageleave']),
    );
    expect(scan.off).toContain('$exception');
    expect(scan.builtins.properties).toBe('posthog-js@1');
  });
});

describe('resolveBuiltins: options with a spread, and two SDKs in one source', () => {
  it('a key written after a spread decides; a key the spread may hold is conditional', () => {
    const scan = builtins('posthog-js/init-spread');
    expect(scan.off).toContain('$pageview');
    expect(scan.builtins.conditional).toEqual(expect.arrayContaining(['$pageleave', '$identify']));
    expect(scan.builtins.events).not.toContain('$pageleave');
  });

  it('a name one SDK sends and the other leaves undecided is sent, not conditional', () => {
    const scan = builtins('posthog-js/mixed-sdks');
    expect(scan.builtins.properties).toBe('posthog-js@1 posthog-react-native@4');
    expect(scan.builtins.events).toContain('$identify');
    expect(scan.builtins.conditional).not.toContain('$identify');
    expect(scan.builtins.conditional).toContain('Application Opened');
  });
});

describe('evaluateCondition (ADR-003)', () => {
  const site = { file: 'a.ts', line: 1 } as InitSite;
  const one = (v: OptionValue) => ({ option: () => v });
  const absent: OptionValue = { kind: 'absent' };
  const unknown: OptionValue = { kind: 'unknown', reason: 'x' };
  const lit = (value: string | number | boolean | null): OptionValue => ({ kind: 'value', value });

  it('not: sent unless the option is that literal; absent keeps the default', () => {
    const when = { option: 'o', not: false as const };
    expect(evaluateCondition(when, [site], one(absent))).toBe('sent');
    expect(evaluateCondition(when, [site], one(lit(false)))).toBe('off');
    expect(evaluateCondition(when, [site], one(lit(true)))).toBe('sent');
    expect(evaluateCondition(when, [site], one({ kind: 'object' }))).toBe('sent');
    expect(evaluateCondition(when, [site], one(unknown))).toBe('conditional');
  });

  it('is true: a truthy literal or an object; absent or falsy is off', () => {
    const when = { option: 'o', is: true as const };
    expect(evaluateCondition(when, [site], one({ kind: 'object' }))).toBe('sent');
    expect(evaluateCondition(when, [site], one(lit('history_change')))).toBe('sent');
    expect(evaluateCondition(when, [site], one(lit(0)))).toBe('off');
    expect(evaluateCondition(when, [site], one(absent))).toBe('off');
    expect(evaluateCondition(when, [site], one(unknown))).toBe('conditional');
  });

  it('is with another literal matches only that literal', () => {
    const when = { option: 'o', is: 'always' };
    expect(evaluateCondition(when, [site], one(lit('always')))).toBe('sent');
    expect(evaluateCondition(when, [site], one(lit('never')))).toBe('off');
  });

  it('always, unknown and no init site', () => {
    expect(evaluateCondition('always', [], one(absent))).toBe('sent');
    expect(evaluateCondition({ unknown: 'remote config' }, [site], one(absent))).toBe(
      'conditional',
    );
    expect(evaluateCondition({ option: 'o', not: false }, [], one(absent))).toBe('conditional');
  });

  it('several init sites: any sent is sent, else any undecided is conditional', () => {
    const when = { option: 'o', not: false as const };
    const values = [lit(false), unknown];
    let i = 0;
    const reader = { option: () => values[i++ % 2] as OptionValue };
    expect(evaluateCondition(when, [site, site], reader)).toBe('conditional');
    const mixed = [lit(false), absent];
    let j = 0;
    expect(evaluateCondition(when, [site, site], { option: () => mixed[j++] as OptionValue })).toBe(
      'sent',
    );
  });
});

describe('platforms (spec 6.4 item 9)', () => {
  const sp = program('posthog-react-native/platforms');
  const events = followWrappers(sp, descriptors).events;
  const byFile = Object.fromEntries(
    events.map((e) => [e.file, sitePlatforms(e.file, e.descriptor.platforms)]),
  );

  it('React Native suffixes narrow the source platforms', () => {
    expect(byFile).toEqual({
      'src/share.ts': ['ios', 'android'],
      'src/share.ios.ts': ['ios'],
      'src/share.android.ts': ['android'],
      'src/share.native.tsx': ['ios', 'android'],
      'src/share.web.ts': ['web'],
    });
  });

  it('a suffix narrows a source with every platform, and plain names are not suffixes', () => {
    expect(sitePlatforms('src/a.ios.tsx', ['web', 'ios', 'android'])).toEqual(['ios']);
    expect(sitePlatforms('src/a.native.js', ['web', 'ios', 'android'])).toEqual(['ios', 'android']);
    expect(sitePlatforms('src/a.web.mjs', ['web', 'ios', 'android'])).toEqual(['web']);
    expect(suffixPlatforms('src/ios.ts')).toBeUndefined();
    expect(suffixPlatforms('src/share.ios.json')).toBeUndefined();
    expect(sitePlatforms('src/iosShare.ts', ['web'])).toEqual(['web']);
  });
});
