// The Segment descriptors end to end (T4.4, ADR-056): the browser SDK through the client
// AnalyticsBrowser.load() returns, the loaded Analytics class and the AnalyticsCore interface,
// track in its name form and its event object form (`event`, `properties`, the second argument
// then being the options), the link and form helpers, identify with an id or with the traits in
// its place, a wrapper, and page calls that are no site; the React Native SDK through
// useAnalytics(), destructured or whole, and the client createClient() returns, with its
// lifecycle builtins read from the config. Negative controls: the app's own track and identify,
// the app's own useAnalytics hook and one from another package (spec T4.4) are never SDK calls.
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

describe('segment-analytics-next with the stub', { timeout: 30000 }, () => {
  const fixture = perMutant(() => extract('segment-analytics-next/calls', ['web']));
  let catalog: Extracted['catalog'];
  beforeEach(() => {
    ({ catalog } = fixture());
  }, 30000);
  const via = (event: string) => catalog.events[event]?.sites.map((s) => s.via.join(' > '));

  it('resolves the SDK from its stub', () => {
    expect(catalog.source.sdks).toEqual([
      { id: 'segment-analytics-next', version: null, types: 'stub' },
    ]);
  });

  it('finds track on the loaded client, the Analytics class and the AnalyticsCore interface', () => {
    expect(Object.keys(catalog.events).sort()).toEqual([
      'Author Page Opened',
      'Book Reserved',
      'Coupon Applied',
      'Gift Wrapped',
      'Newsletter Joined',
      'Shelf Browsed',
      'Store Hours Viewed',
    ]);
    expect(via('Book Reserved')).toEqual(['AnalyticsBuffered.track']);
    expect(via('Shelf Browsed')).toEqual(['Analytics.track']);
    expect(via('Store Hours Viewed')).toEqual(['AnalyticsCore.track']);
    expect(catalog.events['Book Reserved']?.properties).toEqual({
      format: finite('ebook', 'hardcover'),
      pickup: finite(true),
    });
  });

  it('reads the object form from event and properties, never the options argument', () => {
    expect(via('Coupon Applied')).toEqual(['AnalyticsBuffered.track']);
    expect(catalog.events['Coupon Applied']?.properties).toEqual({ tier: finite('gold') });
  });

  it('reads the link and form helpers from their second and third arguments', () => {
    expect(via('Author Page Opened')).toEqual(['AnalyticsBuffered.trackLink']);
    expect(catalog.events['Author Page Opened']?.properties).toEqual({ from: finite('card') });
    expect(via('Newsletter Joined')).toEqual(['AnalyticsBuffered.trackSubmit']);
    expect(catalog.events['Newsletter Joined']?.properties).toEqual({});
  });

  it('follows a wrapper to its call sites', () => {
    expect(via('Gift Wrapped')).toEqual(['sendShop (src/shop.ts:37) > AnalyticsBuffered.track']);
    // The properties object is built inside the wrapper, typed by its parameter.
    expect(catalog.events['Gift Wrapped']?.properties).toEqual({ ribbon: finite('gold', 'red') });
    expect(catalog.events['Gift Card Sent']).toBeUndefined();
  });

  it('leaves a name computed per element open world, and page calls out of the sites', () => {
    expect(catalog.openWorld).toEqual([
      expect.objectContaining({ file: 'src/shop.ts', line: 27, kind: 'event-name' }),
    ]);
    expect(catalog.events.Catalog).toBeUndefined();
    expect(catalog.events.Checkout).toBeUndefined();
    expect(catalog.coverage).toMatchObject({ callSites: 8, literalNameSites: 7, openSites: 1 });
  });

  it('reads the traits from the second argument, or from the first when it is an object', () => {
    expect(Object.keys(catalog.personProperties).sort()).toEqual(['favourite_genre', 'plan']);
    expect(catalog.identity.map((i) => i.call)).toEqual([
      'identify',
      'identify',
      'identify',
      'reset',
    ]);
  });

  it('has no builtin events, and context fields unknown on every event', () => {
    expect(catalog.builtins.events).toEqual([]);
    expect(catalog.builtins.conditional).toEqual(
      expect.arrayContaining(['url', 'userAgent', 'campaign']),
    );
    expect(catalog.builtins.properties).toBe('segment-analytics-next@1');
  });

  it('never matches the app’s own track or identify', () => {
    expect(catalog.events['Local Only']).toBeUndefined();
    expect(catalog.personProperties.loyalty_tier).toBeUndefined();
    expect(catalog.openWorld.filter((o) => o.file === 'src/local.ts')).toEqual([]);
  });
});

describe('segment-analytics-next installed', { timeout: 30000 }, () => {
  const fixture = perMutant(() => extract('segment-analytics-next/installed', ['web']));
  let catalog: Extracted['catalog'];
  beforeEach(() => {
    ({ catalog } = fixture());
  }, 30000);

  it('matches the package’s own arrow-typed members and rest-tuple methods', () => {
    expect(catalog.source.sdks).toEqual([
      { id: 'segment-analytics-next', version: '1.84.3', types: 'installed' },
    ]);
    expect(catalog.events['Book Reserved']?.sites.map((s) => s.via)).toEqual([
      ['AnalyticsBuffered.track'],
    ]);
    expect(catalog.events['Shelf Browsed']?.sites.map((s) => s.via)).toEqual([['Analytics.track']]);
    expect(catalog.events['Shelf Browsed']?.properties).toEqual({ aisle: finite(7) });
    expect(Object.keys(catalog.personProperties)).toEqual(['favourite_genre']);
    expect(catalog.coverage).toMatchObject({ callSites: 2, literalNameSites: 2, openSites: 0 });
  });
});

describe('segment-analytics-react-native with the stub', { timeout: 30000 }, () => {
  const fixture = perMutant(() => extract('segment-analytics-react-native/calls', ['ios', 'android']));
  let catalog: Extracted['catalog'];
  beforeEach(() => {
    ({ catalog } = fixture());
  }, 30000);
  const via = (event: string) => catalog.events[event]?.sites.map((s) => s.via.join(' > '));

  it('finds track through useAnalytics(), destructured or whole, and on the client', () => {
    expect(catalog.source.sdks).toEqual([
      { id: 'segment-analytics-react-native', version: null, types: 'stub' },
    ]);
    expect(Object.keys(catalog.events).sort()).toEqual([
      'Branch Visited',
      'Hold Placed',
      'Review Rated',
    ]);
    expect(via('Hold Placed')).toEqual(['ClientMethods.track']);
    expect(via('Review Rated')).toEqual(['ClientMethods.track']);
    expect(via('Branch Visited')).toEqual(['SegmentClient.track']);
    expect(catalog.events['Hold Placed']?.properties).toEqual({
      format: finite('audiobook', 'paperback'),
    });
    expect(catalog.coverage).toMatchObject({ callSites: 3, literalNameSites: 3, openSites: 0 });
  });

  it('reads identify traits and identity calls from the hook', () => {
    expect(Object.keys(catalog.personProperties)).toEqual(['reading_goal']);
    expect(catalog.identity.map((i) => i.call)).toEqual(['identify', 'reset']);
  });

  it('reads the lifecycle builtins from the createClient config', () => {
    expect(catalog.builtins.events).toEqual(
      expect.arrayContaining([
        'Application Installed',
        'Application Updated',
        'Application Opened',
        'Application Backgrounded',
      ]),
    );
    expect(catalog.builtins.off).toEqual(
      expect.arrayContaining(['Deep Link Opened', 'referring_application']),
    );
    expect(catalog.builtins.conditional).toEqual(expect.arrayContaining(['app', 'os', 'device']));
    expect(catalog.builtins.properties).toBe('segment-analytics-react-native@2');
  });

  // Spec T4.4 negative control: a hook of the same name from another package is not matched.
  it('never matches another useAnalytics, the app’s own or another package’s', () => {
    expect(catalog.events['Local Only']).toBeUndefined();
    expect(catalog.events['Metrics Only']).toBeUndefined();
    expect(catalog.personProperties.loyalty_tier).toBeUndefined();
    expect(catalog.openWorld).toEqual([]);
  });
});
