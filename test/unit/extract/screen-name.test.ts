// ADR-047 (T11.3a): posthog-react-native's screen() registers $screen_name for the session, so the
// property may ride on every event. "yes, sometimes" with a screen() call, "unknown" when a provider
// or the navigation integration may call screen() by itself, "no" only when every caller is off.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import {
  builtinTables,
  callState,
  createSourceProgram,
  extractCatalog,
  mergeCatalogs,
  propertyFact,
  resolveBuiltins,
  type AutoSite,
  type BuiltinScan,
  type CallCondition,
  type InitSite,
} from '../../../src/extract/index.js';
import type { Catalog } from '../../../src/formats/catalog.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;
const tables = builtinTables(descriptors);
const rn = descriptors.find((d) => d.sdk === 'posthog-react-native');
if (!rn) throw new Error('no posthog-react-native descriptor');
const row = rn.builtins.properties.find((p) => p.name === '$screen_name');
if (!row || row.when === 'always' || !('call' in row.when)) throw new Error('no call row');
const SCREEN: CallCondition = row.when;

function extract(fixture: string): Catalog {
  const r = extractCatalog({
    repoRoot: join(FIXTURES, 'posthog-react-native/screen-name', fixture),
    source: { name: 'app', path: '.' },
    descriptors,
    tool: '0.0.0-test',
    platforms: ['ios', 'android'],
    commit: null,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value.catalog;
}

function scan(fixture: string): BuiltinScan {
  const r = createSourceProgram({
    repoRoot: join(FIXTURES, 'posthog-react-native/screen-name', fixture),
    source: { name: 'app', path: '.' },
    descriptors,
  });
  if (!r.ok) throw new Error(r.error);
  return resolveBuiltins(r.value);
}

const fact = (fixture: string, event: string) =>
  propertyFact(mergeCatalogs([extract(fixture)], tables), event, '$screen_name');

describe('$screen_name on posthog-react-native events (ADR-047)', () => {
  it('a screen() call: yes, sometimes, on every event; always on $screen', () => {
    const f = fact('called', 'book_previewed');
    expect(f.fact).toBe('yes');
    expect(f.property?.presence).toBe('sometimes');
    expect(fact('called', '$screen').property?.presence).toBe('always');
    const c = extract('called');
    expect(c.builtins.conditional).not.toContain('$screen_name');
    expect(c.builtins.off).not.toContain('$screen_name');
  });

  it('a provider with the default autocapture: unknown, a conditional builtin', () => {
    expect(fact('provider-default', 'cart_viewed')).toEqual({
      fact: 'unknown',
      unknown: ['conditional-builtin'],
    });
    expect(extract('provider-default').builtins.conditional).toContain('$screen_name');
  });

  it('negative control: captureScreens false, autocapture false and no screen() call: no', () => {
    expect(fact('provider-off', 'wishlist_added')).toEqual({ fact: 'no', unknown: [] });
    const s = scan('provider-off');
    expect(s.off).toContain('$screen_name');
    expect(s.autos.map((a) => [a.line, a.state])).toEqual([
      [9, 'off'],
      [19, 'off'],
    ]);
  });

  it('a spread, a bare autocapture, a non-literal option and the navigation integration stay unknown', () => {
    const s = scan('edges');
    expect(s.autos.map((a) => [a.line, a.state])).toEqual([
      [11, 'conditional'],
      [20, 'conditional'],
      [30, 'conditional'],
      [37, 'conditional'],
      [38, 'off'],
    ]);
    expect(s.builtins.conditional).toContain('$screen_name');
  });

  it('autocapture true, captureScreens true, a spread beside false and a bare integration stay unknown', () => {
    const s = scan('more-edges');
    // The app's own <Shelf /> (line 39) is no caller and must not stop the scan.
    expect(s.autos.map((a) => [a.line, a.state])).toEqual([
      [11, 'conditional'],
      [20, 'conditional'],
      [29, 'conditional'],
      [42, 'conditional'],
    ]);
    expect(s.builtins.conditional).toContain('$screen_name');
    expect(s.off).not.toContain('$screen_name');
  });
});

describe('callState (ADR-047)', () => {
  const init = { descriptor: rn } as unknown as InitSite;
  const auto = (state: AutoSite['state'], caller = SCREEN.auto?.[0]): AutoSite =>
    ({ file: 'a.tsx', line: 1, descriptor: rn, caller, state }) as AutoSite;
  const none = { calls: [], openCalls: [] };
  const screenCall = { descriptor: rn, entry: { member: 'screen' } };

  it('a resolved call of the member sends it, whatever the callers', () => {
    const calls = { calls: [screenCall], openCalls: [] } as never;
    expect(callState(SCREEN, rn, calls, [auto('off')], [init])).toBe('sent');
  });

  it('a call of another member, or of the member on another SDK, does not', () => {
    const other = descriptors.find((d) => d !== rn);
    const calls = {
      calls: [
        { descriptor: rn, entry: { member: 'capture' } },
        { descriptor: other, entry: { member: 'screen' } },
      ],
      openCalls: [{ descriptor: other, member: 'screen' }],
    } as never;
    expect(callState(SCREEN, rn, calls, [], [init])).toBe('off');
  });

  it('an open-world call that may be the member is conditional', () => {
    const calls = { calls: [], openCalls: [{ descriptor: rn, member: 'screen' }] } as never;
    expect(callState(SCREEN, rn, calls, [auto('off')], [init])).toBe('conditional');
  });

  it('any caller not turned off is conditional; all off is off', () => {
    expect(callState(SCREEN, rn, none, [auto('off'), auto('conditional')], [init])).toBe(
      'conditional',
    );
    expect(callState(SCREEN, rn, none, [auto('off'), auto('off')], [])).toBe('off');
  });

  it('a caller of another condition does not count', () => {
    const foreign = { component: 'OtherProvider', prop: 'auto', option: 'x' };
    expect(callState(SCREEN, rn, none, [auto('conditional', foreign)], [init])).toBe('off');
  });

  it('a call condition with no auto callers counts none of the source callers', () => {
    const plain: CallCondition = { call: SCREEN.call };
    expect(callState(plain, rn, none, [auto('conditional')], [init])).toBe('off');
  });

  it('no init and no caller: the client is made elsewhere, so conditional', () => {
    expect(callState(SCREEN, rn, none, [], [])).toBe('conditional');
    expect(callState(SCREEN, rn, none, [], [init])).toBe('off');
  });
});
