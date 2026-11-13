// The invented bookshop (spec 6.17) for the report goldens: a web source and a mobile source, one
// dashboard with a tile of every verdict, alerts, an ignore list and PostHog's observed data.
import {
  applyIgnore,
  checkAlerts,
  checkContext,
  checkTiles,
  type CheckContext,
  type IgnoreEntry,
} from '../../../src/check/index.js';
import type { Catalog, CatalogEvent, PropertyFact } from '../../../src/formats/catalog.js';
import type { Requirements, SeriesNode, Tile } from '../../../src/formats/requirements.js';
import { validateCatalog, validateRequirements } from '../../../src/formats/validate.js';
import { buildReport, type ReportModel } from '../../../src/report/index.js';

export const PULLED = '2026-12-18T09:12:00Z';
const RECENT = '2026-12-17T08:00:00Z';
export const NOW = new Date('2026-12-18T09:30:00Z');

const finite = (set: string[]): PropertyFact => ({
  presence: 'always',
  values: { kind: 'finite', set },
});

function event(
  file: string,
  line: number,
  platforms: string[],
  properties: Record<string, PropertyFact> = {},
): CatalogEvent {
  return {
    sites: [{ file, line, sdk: 'posthog-js', via: [], platforms, openProperties: false }],
    openSites: 0,
    properties,
  };
}

function catalog(
  name: string,
  platforms: string[],
  events: Record<string, CatalogEvent>,
  coverage: { callSites: number; literalNameSites: number },
): Catalog {
  const c: Catalog = {
    schema: 'dashlint.catalog/1',
    tool: '0.1.0',
    source: {
      name,
      root: name,
      commit: '5f0c2e1',
      platforms,
      sdks: [{ id: 'posthog-js', version: '1.200.0', types: 'stub' }],
    },
    openWorld: [],
    events,
    superProperties: {},
    personProperties: {},
    builtins: { events: [], properties: null, conditional: [], off: [] },
    identity: [],
    coverage: {
      files: 12,
      excludedFiles: 0,
      callSites: coverage.callSites,
      literalNameSites: coverage.literalNameSites,
      openSites: coverage.callSites - coverage.literalNameSites,
      nameResolutionRate:
        Math.round((coverage.literalNameSites / coverage.callSites) * 1000) / 1000,
    },
  };
  const v = validateCatalog(c);
  if (!v.ok) throw new Error(`invalid bookshop catalog: ${JSON.stringify(v.errors)}`);
  return c;
}

const WEB = ['web'];
const MOBILE = ['android', 'ios'];

export const catalogs = (): Catalog[] => [
  catalog(
    'web',
    WEB,
    {
      book_viewed: event('src/catalog/book.ts', 20, WEB),
      wishlist_shared: event('src/wishlist/share.ts', 41, WEB, {
        genre_id: finite(['fiction', 'poetry']),
      }),
      checkout_started: event('src/checkout/start.ts', 12, WEB),
      payment_submitted: event('src/checkout/pay.ts', 63, WEB, {
        payment_method: finite(['card', 'wallet']),
      }),
      order_completed: event('src/checkout/complete.ts', 30, WEB),
      giftcard_redeemed: event('src/checkout/gift.ts', 88, WEB),
      review_submitted: event('src/reviews/submit.ts', 15, WEB),
    },
    { callSites: 33, literalNameSites: 31 },
  ),
  catalog(
    'mobile',
    MOBILE,
    {
      book_viewed: event('src/catalog/book.tsx', 22, MOBILE),
      wishlist_shared: event('src/wishlist/share.ts', 27, MOBILE, {
        genre_id: finite(['fiction', 'poetry']),
      }),
      checkout_started: event('src/checkout/start.ts', 9, MOBILE),
      payment_submitted: event('src/checkout/pay.ts', 40, MOBILE, {
        payment_method: finite(['card', 'wallet']),
      }),
      order_completed: event('src/orders/complete.ts', 30, MOBILE),
      book_previewed: event('src/reader/preview.tsx', 19, MOBILE),
    },
    { callSites: 28, literalNameSites: 27 },
  ),
];

const ev = (name: string, extra: Partial<Extract<SeriesNode, { node: 'event' }>> = {}) =>
  ({ node: 'event', event: name, ...extra }) as SeriesNode;

function tile(
  id: string,
  title: string,
  kind: Tile['kind'],
  series: SeriesNode[],
  extra: Partial<Tile> = {},
): Tile {
  return {
    id,
    title,
    url: `https://us.posthog.com/project/12345/insights/${id.slice('insight:'.length)}`,
    dashboards: ['dashboard:41'],
    kind,
    series: series.map((s, i) => ({ ...s, ref: String.fromCharCode(65 + i) })),
    ...extra,
  };
}

const seen = (at: string | null = RECENT) => ({ defined: true, lastSeenAt: at });

export function requirements(observed = true): Requirements {
  const r: Requirements = {
    schema: 'dashlint.requirements/1',
    source: { platform: 'posthog', project: 12345, pulledAt: PULLED, tool: '0.1.0' },
    dashboards: [{ id: 'dashboard:41', name: 'Bookshop growth' }],
    tiles: [
      tile('insight:Bv01', 'Books viewed', 'trends', [ev('book_viewed')]),
      tile('insight:Ws02', 'Wishlist shares, fiction', 'trends', [
        ev('wishlist_shared', {
          filters: [{ key: 'genre', scope: 'event', op: 'exact', values: ['Fiction'] }],
        }),
      ]),
      tile('insight:Gc03', 'Gift cards redeemed', 'trends', [ev('gift_card_redeemed')]),
      tile('insight:Cf04', 'Checkout funnel', 'funnels', [
        ev('book_viewed'),
        ev('checkout_started'),
        ev('payment_submitted', {
          filters: [{ key: 'payment_method', scope: 'event', op: 'exact', values: ['Voucher'] }],
        }),
        ev('order_completed'),
      ]),
      tile('insight:Of05', 'Orders by format', 'trends', [ev('order_completed')], {
        breakdown: [{ key: 'format', scope: 'event' }],
      }),
      tile('insight:Rs06', 'Reviews submitted', 'trends', [ev('review_submitted')]),
      {
        id: 'insight:Rc07',
        title: 'Revenue by cohort',
        dashboards: ['dashboard:41'],
        kind: 'sql',
        notChecked: [{ reason: 'a SQL query' }],
      },
      tile('insight:Bp08', 'Books previewed', 'trends', [ev('book_previewed')]),
      tile('insight:Sa09', 'Shelves archived', 'trends', [ev('shelf_archived')]),
      tile('insight:Ca10', 'Checkouts by method', 'trends', [ev('checkout_started')], {
        dashboards: [],
        series: [
          {
            node: 'event',
            event: 'checkout_started',
            ref: 'A',
            filters: [{ key: 'coupon', scope: 'event', op: 'is_not', values: ['none'] }],
          },
        ],
      }),
    ],
    alerts: [
      {
        id: 'alert:0b7e',
        name: 'Gift cards dropped',
        tile: 'insight:Gc03',
        target: { kind: 'series', index: 0 },
        condition: 'relative_increase',
        bounds: { lower: false, upper: true },
        state: 'Not firing',
      },
      {
        id: 'alert:0c8f',
        name: 'Gift cards below ten',
        tile: 'insight:Gc03',
        target: { kind: 'series', index: 0 },
        condition: 'absolute_value',
        bounds: { lower: true, upper: false },
        state: null,
        enabled: false,
      },
      {
        id: 'alert:1c2d',
        name: 'Views fell',
        tile: 'insight:Bv01',
        target: { kind: 'series', index: 0 },
        condition: 'absolute_value',
        bounds: { lower: true, upper: false },
        state: 'Not firing',
      },
      {
        id: 'alert:2e3f',
        name: 'Reviews spike',
        tile: 'insight:Rs06',
        target: { kind: 'series', index: 2 },
        condition: 'absolute_value',
        bounds: { lower: false, upper: true },
        state: 'Errored',
      },
    ],
  };
  if (observed)
    r.observed = {
      windowDays: 30,
      events: {
        book_viewed: seen(),
        wishlist_shared: seen(),
        checkout_started: seen(),
        payment_submitted: seen(),
        order_completed: seen(),
        giftcard_redeemed: seen(),
        review_submitted: seen(),
        book_previewed: seen('2026-10-02T11:00:00Z'),
        gift_card_redeemed: { defined: false },
      },
      eventProperties: {
        wishlist_shared: { seen: ['genre_id'], notSeen: ['genre'] },
        checkout_started: { seen: [], notSeen: ['coupon'] },
      },
    };
  const v = validateRequirements(r);
  if (!v.ok) throw new Error(`invalid bookshop requirements: ${JSON.stringify(v.errors)}`);
  return r;
}

export function context(cats: Catalog[], req: Requirements): CheckContext {
  return checkContext(cats, req, new Map());
}

export const IGNORE: IgnoreEntry[] = [
  { kind: 'tile', id: 'insight:Sa09', reason: 'shelves are being retired' },
  { kind: 'tile', id: 'insight:Of05', reason: 'formats ship next sprint', until: '2026-12-01' },
];

/** The bookshop checked end to end: tiles, alerts, ignore list, report model. */
export function bookshop(
  options: {
    observed?: boolean;
    ignore?: IgnoreEntry[];
    catalogs?: Catalog[];
    requirements?: Requirements;
    mode?: ReportModel['report']['mode'];
  } = {},
): ReportModel {
  const cats = options.catalogs ?? catalogs();
  const req = options.requirements ?? requirements(options.observed ?? true);
  const ctx = context(cats, req);
  const outcome = applyIgnore(
    req,
    checkTiles(ctx, req),
    checkAlerts(ctx, req),
    options.ignore ?? IGNORE,
    NOW,
  );
  return buildReport({
    tool: '0.1.0',
    mode: options.mode ?? 'check',
    requirements: req,
    catalogs: cats,
    ctx,
    outcome,
  });
}
