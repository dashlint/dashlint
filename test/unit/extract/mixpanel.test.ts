// The Mixpanel descriptors end to end (T4.2, ADR-054): the browser SDK through its default export,
// a namespace import and a named import (module-level functions), track_with_groups merging the
// groups into the properties, the fixed page view event, people.set in both forms, and the React
// Native SDK with people through getPeople(). Negative controls: a `people.set`, a `track` and a
// `People` class of the app's own are never SDK calls.
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

describe('mixpanel-browser with the stub', { timeout: 30000 }, () => {
  const fixture = perMutant(() => extract('mixpanel-browser/calls', ['web']));
  let catalog: Extracted['catalog'];
  beforeEach(() => {
    ({ catalog } = fixture());
  }, 30000);
  const via = (event: string) => catalog.events[event]?.sites.map((s) => s.via.join(' > '));

  it('resolves the SDK from its stub', () => {
    expect(catalog.source.sdks).toEqual([{ id: 'mixpanel-browser', version: null, types: 'stub' }]);
  });

  it('finds events through the default export, a namespace import and a named import', () => {
    expect(Object.keys(catalog.events).sort()).toEqual([
      '$mp_web_page_view',
      'book_previewed',
      'book_reserved',
      'book_shelved',
      'gift_card_link_clicked',
      'wishlist_opened',
    ]);
    expect(via('book_shelved')).toEqual(['Mixpanel.track']);
    expect(via('book_previewed')).toEqual(['(module).track']);
    expect(via('wishlist_opened')).toEqual(['(module).track']);
    expect(via('$mp_web_page_view')).toEqual(['Mixpanel.track_pageview']);
    expect(catalog.coverage).toMatchObject({ callSites: 6, literalNameSites: 6, openSites: 0 });
  });

  it('reads the properties of track, including a literal union', () => {
    expect(catalog.events.book_shelved?.properties).toEqual({
      genre: { presence: 'always', values: { kind: 'finite', set: ['fiction', 'poetry'] } },
      staff_pick: { presence: 'always', values: { kind: 'finite', set: [false] } },
    });
  });

  it('merges the groups of track_with_groups into its properties', () => {
    expect(catalog.events.book_reserved?.properties).toEqual({
      branch_id: { presence: 'always', values: { kind: 'open', type: 'string' } },
      format: { presence: 'always', values: { kind: 'finite', set: ['paperback'] } },
    });
  });

  it('sends the page view under its fixed name with the given properties', () => {
    expect(catalog.events.$mp_web_page_view?.properties).toEqual({
      section: { presence: 'always', values: { kind: 'finite', set: ['new arrivals'] } },
    });
  });

  it('leaves the properties of track_links open when they are a function of the element', () => {
    const site = catalog.events.gift_card_link_clicked?.sites[0];
    expect(site?.openProperties).toBe(true);
    expect(catalog.events.gift_card_link_clicked?.openSites).toBe(1);
  });

  it('reads register and register_once as super properties', () => {
    expect(Object.keys(catalog.superProperties).sort()).toEqual(['first_visit', 'store']);
  });

  it('reads people.set in its object and string forms, and people.set_once', () => {
    expect(Object.keys(catalog.personProperties).sort()).toEqual([
      'favourite_genre',
      'joined_year',
      'plan',
    ]);
  });

  it('records identify and reset as identity calls', () => {
    expect(catalog.identity.map((i) => i.call).sort()).toEqual(['identify', 'reset']);
  });

  it('decides the autocapture and marketing builtins from the init options', () => {
    // autocapture is an object (on), track_marketing is false (off), the page view is undecidable.
    expect(catalog.builtins.events).toContain('$mp_click');
    expect(catalog.builtins.off).toEqual(expect.arrayContaining(['utm_source', 'gclid', 'wbraid']));
    expect(catalog.builtins.conditional).toEqual(
      expect.arrayContaining(['$mp_web_page_view', '$mp_page_leave', '$user_id']),
    );
    expect(catalog.builtins.properties).toBe('mixpanel-browser@2');
  });

  // Spec T4.2 negative control.
  it('never matches the app’s own people.set, track or People', () => {
    expect(catalog.events.local_event_only).toBeUndefined();
    expect(catalog.personProperties.loyalty_tier).toBeUndefined();
    const lines = Object.values(catalog.personProperties).flatMap((p) =>
      p.sites.map((s) => s.file),
    );
    expect(lines).not.toContain('src/local.ts');
    expect(catalog.openWorld.filter((o) => o.file === 'src/local.ts')).toEqual([]);
  });
});

describe('mixpanel-browser installed', { timeout: 30000 }, () => {
  const fixture = perMutant(() => extract('mixpanel-browser/installed', ['web']));
  let catalog: Extracted['catalog'];
  beforeEach(() => {
    ({ catalog } = fixture());
  }, 30000);

  it('matches module-level functions declared at the top of the package’s own types', () => {
    expect(catalog.source.sdks).toEqual([
      { id: 'mixpanel-browser', version: '2.85.0', types: 'installed' },
    ]);
    expect(catalog.events.book_shelved?.sites.map((s) => s.via)).toEqual([['Mixpanel.track']]);
    expect(catalog.events.book_previewed?.sites.map((s) => s.via)).toEqual([['(module).track']]);
    expect(Object.keys(catalog.personProperties)).toEqual(['newsletter']);
  });

  it('reads the init options of the module-level init', () => {
    expect(catalog.builtins.off).toEqual(expect.arrayContaining(['utm_source']));
  });
});

describe('mixpanel-react-native with the stub', { timeout: 30000 }, () => {
  const fixture = perMutant(() => extract('mixpanel-react-native/calls', ['ios', 'android']));
  let catalog: Extracted['catalog'];
  beforeEach(() => {
    ({ catalog } = fixture());
  }, 30000);

  it('finds track and trackWithGroups with their properties', () => {
    expect(Object.keys(catalog.events).sort()).toEqual(['book_borrowed', 'book_reserved']);
    expect(catalog.events.book_borrowed?.properties).toEqual({
      format: { presence: 'always', values: { kind: 'finite', set: ['audiobook', 'paperback'] } },
    });
    expect(catalog.events.book_reserved?.properties).toEqual({
      branch_id: { presence: 'always', values: { kind: 'open', type: 'string' } },
      format: { presence: 'always', values: { kind: 'finite', set: ['paperback'] } },
    });
    expect(catalog.events.book_borrowed?.sites[0]?.via).toEqual(['Mixpanel.track']);
  });

  it('reads super properties and people through getPeople()', () => {
    expect(Object.keys(catalog.superProperties).sort()).toEqual(['first_launch', 'store']);
    expect(Object.keys(catalog.personProperties).sort()).toEqual([
      'favourite_genre',
      'joined_year',
      'plan',
    ]);
    expect(catalog.identity.map((i) => i.call).sort()).toEqual(['identify', 'reset']);
  });

  it('lists its builtins with no init options to read', () => {
    expect(catalog.builtins.properties).toBe('mixpanel-react-native@4');
    expect(catalog.builtins.events).toEqual([]);
    expect(catalog.builtins.conditional).toEqual(
      expect.arrayContaining(['$user_id', '$manufacturer', '$android_brand']),
    );
  });

  // Spec T4.2 negative control, React Native form.
  it('never matches the app’s own People class', () => {
    expect(catalog.personProperties.loyalty_tier).toBeUndefined();
  });
});
