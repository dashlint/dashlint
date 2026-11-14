// The Amplitude descriptors end to end (T4.3, ADR-055): the browser SDK through a namespace import,
// named imports (module-level consts in the installed types) and a client from createInstance(),
// track in its name form and its event object form (`event_type`, `event_properties`), a wrapper
// that passes the event object on, person properties through Identify, and init options at
// args[1] or args[2]; the React Native SDK with its screen view helpers. Negative controls: an
// event object without event_type and an untyped one are open world, and the app's own `track`,
// `trackScreenView` and `Identify` are never SDK calls.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDescriptors } from '../../../src/descriptors/index.js';
import { extractCatalog, type Extracted } from '../../../src/extract/index.js';
import type { Platform } from '../../../src/descriptors/index.js';
import { perMutant } from '../per-mutant.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors = loaded.value;

function extract(repo: string, platforms: Platform[]): Extracted {
  const r = extractCatalog({
    repoRoot: join(FIXTURES, repo),
    source: { name: 'app', path: '.' },
    descriptors,
    tool: '0.0.0-test',
    platforms,
    commit: null,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const finite = (...set: (string | number | boolean)[]) => ({
  presence: 'always',
  values: { kind: 'finite', set },
});

describe('amplitude-browser with the stub', { timeout: 30000 }, () => {
  const fixture = perMutant(() => extract('amplitude-browser/calls', ['web']));
  let catalog: Extracted['catalog'];
  beforeEach(() => {
    ({ catalog } = fixture());
  }, 30000);
  const via = (event: string) => catalog.events[event]?.sites.map((s) => s.via.join(' > '));

  it('resolves the SDK from its stub', () => {
    expect(catalog.source.sdks).toEqual([
      { id: 'amplitude-browser', version: null, types: 'stub' },
    ]);
  });

  it('finds events through a namespace import, named imports and createInstance()', () => {
    expect(Object.keys(catalog.events).sort()).toEqual([
      'book_previewed',
      'book_shelved',
      'gift_card_bought',
      'review_posted',
      'store_visited',
      'wishlist_opened',
    ]);
    expect(via('book_shelved')).toEqual(['(module).track']);
    expect(via('wishlist_opened')).toEqual(['(module).track']);
    expect(via('gift_card_bought')).toEqual(['(module).logEvent']);
    expect(via('store_visited')).toEqual(['CoreClient.track']);
  });

  it('reads the name form with its properties, including a literal union', () => {
    expect(catalog.events.book_shelved?.properties).toEqual({
      genre: finite('fiction', 'poetry'),
      staff_pick: finite(false),
    });
  });

  it('reads the object form from event_type and event_properties', () => {
    expect(via('book_previewed')).toEqual(['(module).track']);
    expect(catalog.events.book_previewed?.properties).toMatchObject({ source: finite('shelf') });
  });

  it('merges the eventProperties argument into an event object’s properties', () => {
    expect(catalog.events.book_previewed?.properties).toEqual({
      device: finite('kiosk'),
      source: finite('shelf'),
    });
    expect(catalog.events.gift_card_bought?.properties).toEqual({
      amount_band: finite('small'),
      channel: finite('web'),
    });
  });

  it('follows a wrapper that passes an event object on', () => {
    expect(via('review_posted')).toEqual(['sendEvent (src/shelf.ts:43) > (module).track']);
    expect(catalog.events.review_posted?.properties).toEqual({ stars: finite(5) });
  });

  // Spec T4.3 negative control: an object without event_type is open world, not a name; so is an
  // event object typed `any`.
  it('leaves an event object without event_type, or of type any, open world', () => {
    expect(catalog.openWorld).toEqual([
      {
        file: 'src/legacy.js',
        line: 6,
        kind: 'event-name',
        reason: 'event name is read from `event_type`, which its value does not have',
      },
      { file: 'src/legacy.js', line: 11, kind: 'event-name', reason: 'event name has type `any`' },
    ]);
    expect(catalog.coverage).toMatchObject({ callSites: 8, literalNameSites: 6, openSites: 2 });
  });

  it('reads Identify set and setOnce as person properties', () => {
    expect(Object.keys(catalog.personProperties).sort()).toEqual(['joined_year', 'plan']);
  });

  it('records setUserId and identify as identify, and reset', () => {
    expect(catalog.identity.map((i) => i.call)).toEqual(['identify', 'identify', 'reset']);
  });

  it('reads the init options from args[2] when the call passes a user id slot', () => {
    expect(catalog.builtins.events).toContain('[Amplitude] Element Clicked');
    expect(catalog.builtins.events).toContain('session_start');
    expect(catalog.builtins.off).toEqual(
      expect.arrayContaining(['[Amplitude] Page Viewed', '[Amplitude] Page Path', 'ip']),
    );
    expect(catalog.builtins.off).not.toContain('utm_source');
    expect(catalog.builtins.properties).toBe('amplitude-browser@2');
  });

  it('never matches the app’s own track or Identify', () => {
    expect(catalog.events.local_event_only).toBeUndefined();
    expect(catalog.personProperties.loyalty_tier).toBeUndefined();
    expect(catalog.openWorld.filter((o) => o.file === 'src/local.ts')).toEqual([]);
  });
});

describe('amplitude-browser installed', { timeout: 30000 }, () => {
  const fixture = perMutant(() => extract('amplitude-browser/installed', ['web']));
  let catalog: Extracted['catalog'];
  beforeEach(() => {
    ({ catalog } = fixture());
  }, 30000);

  it('matches the module-level consts of the package’s own types', () => {
    expect(catalog.source.sdks).toEqual([
      { id: 'amplitude-browser', version: '2.49.2', types: 'installed' },
    ]);
    expect(catalog.events.book_shelved?.sites.map((s) => s.via)).toEqual([['(module).track']]);
    expect(catalog.events.book_previewed?.properties).toEqual({ source: finite('window') });
    expect(catalog.events.store_visited?.sites.map((s) => s.via)).toEqual([
      ['CoreClient.logEvent'],
    ]);
    expect(Object.keys(catalog.personProperties)).toEqual(['newsletter']);
    expect(catalog.coverage).toMatchObject({ callSites: 3, literalNameSites: 3, openSites: 0 });
  });

  it('reads the options of the const init, given second', () => {
    expect(catalog.builtins.off).toEqual(expect.arrayContaining(['utm_source', 'language']));
    expect(catalog.builtins.events).toContain('[Amplitude] Page Viewed');
    expect(catalog.builtins.off).toContain('[Amplitude] Element Clicked');
  });
});

describe('amplitude-react-native with the stub', { timeout: 30000 }, () => {
  const fixture = perMutant(() => extract('amplitude-react-native/calls', ['ios', 'android']));
  let catalog: Extracted['catalog'];
  beforeEach(() => {
    ({ catalog } = fixture());
  }, 30000);

  it('finds track in both forms', () => {
    expect(catalog.events.book_borrowed?.properties).toEqual({
      format: finite('audiobook', 'paperback'),
    });
    expect(catalog.events.loan_renewed?.properties).toEqual({ weeks: finite(2) });
    expect(catalog.events.loan_renewed?.sites[0]?.via).toEqual(['(module).track']);
  });

  it('sends the screen views under their fixed name with the screen name added', () => {
    const screen = catalog.events['[Amplitude] Screen Viewed'];
    expect(screen?.sites.map((s) => s.via.join(' > '))).toEqual([
      '(module).trackScreenView',
      '(module).trackScreenViewOnNavigationStateChange',
      'ReactNativeClient.trackScreenView',
    ]);
    // The navigation-state helper adds the name at runtime: sometimes, from the code's view.
    expect(screen?.properties['[Amplitude] Screen Name']).toEqual({
      presence: 'sometimes',
      values: { kind: 'finite', set: ['Returns', 'Shelf'] },
    });
    expect(catalog.coverage).toMatchObject({ callSites: 5, literalNameSites: 5, openSites: 0 });
  });

  it('reads person properties from a chained Identify, and identity calls', () => {
    expect(Object.keys(catalog.personProperties).sort()).toEqual(['joined_year', 'plan']);
    expect(catalog.identity.map((i) => i.call)).toEqual(['identify', 'identify', 'reset']);
  });

  it('decides lifecycle builtins under autocapture and leaves sessions conditional', () => {
    expect(catalog.builtins.events).toEqual(
      expect.arrayContaining(['[Amplitude] Application Opened', '[Amplitude] Application Updated']),
    );
    // trackingSessionEvents or autocapture.sessions: one condition cannot read both options.
    expect(catalog.builtins.conditional).toEqual(
      expect.arrayContaining(['session_start', 'session_end', '[Amplitude] Screen Viewed']),
    );
    expect(catalog.builtins.off).toEqual(
      expect.arrayContaining(['[Amplitude] Element Interacted', 'country']),
    );
    expect(catalog.builtins.properties).toBe('amplitude-react-native@1');
  });

  it('never matches the app’s own trackScreenView or Identify', () => {
    expect(catalog.events['[Amplitude] Screen Viewed']?.sites).toHaveLength(3);
    expect(catalog.personProperties.loyalty_tier).toBeUndefined();
  });
});
