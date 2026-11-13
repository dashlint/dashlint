import { describe, expect, it } from 'vitest';
import {
  LOW_NAME_RESOLUTION,
  PERSON_NOT_OBSERVED,
  eventFacts,
  factInputs,
  genericProfile,
  personPropertyFacts,
  posthogProfile,
  propertyFacts,
  type CodeFact,
  type CodeFacts,
  type FactInputs,
  type PropertyCodeFact,
} from '../../../src/check/index.js';
import {
  eventFact,
  mergeCatalogs,
  personPropertyFact,
  propertyFact,
} from '../../../src/extract/index.js';
import type { Catalog } from '../../../src/formats/catalog.js';
import type { Observed, Requirements } from '../../../src/formats/requirements.js';
import { validateCatalog } from '../../../src/formats/validate.js';

const PULLED = '2026-12-18T09:12:00Z';
const RECENT = '2026-12-17T08:00:00Z';
const OLD = '2026-10-01T08:00:00Z';

type Tri = CodeFact['fact'];

function fact(f: Tri, unknown: string[] = f === 'unknown' ? ['open-event-name'] : []): CodeFact {
  return { fact: f, unknown };
}

/** Code facts given per name; anything not listed is "no". */
function code(
  parts: {
    events?: Record<string, CodeFact>;
    properties?: Record<string, PropertyCodeFact>;
    person?: Record<string, CodeFact>;
    rates?: number[];
  } = {},
): CodeFacts {
  const pick = <T>(m: Record<string, T> | undefined, k: string, d: T): T =>
    m !== undefined && Object.hasOwn(m, k) ? (m[k] as T) : d;
  return {
    event: (name) => pick(parts.events, name, fact('no')),
    property: (event, key) => pick(parts.properties, `${event}.${key}`, fact('no')),
    personProperty: (key) => pick(parts.person, key, fact('no')),
    nameResolutionRates: parts.rates ?? [1],
  };
}

function observed(parts: Partial<Observed> = {}): Observed {
  return { windowDays: 30, events: {}, ...parts };
}

function inputs(c: CodeFacts, o?: Observed): FactInputs {
  return { code: c, ...(o === undefined ? {} : { observed: o }), pulledAt: PULLED };
}

const seenRecently = { defined: true, lastSeenAt: RECENT };
const seenLongAgo = { defined: true, lastSeenAt: OLD };

describe('6.7.1 event table, one test per row', () => {
  it('code no, observed no: dead (high confidence)', () => {
    const r = eventFacts(
      inputs(code(), observed({ events: { order_completed: { defined: false } } })),
      'order_completed',
    );
    expect(r).toEqual({ code: 'no', observed: 'no', status: 'dead', basis: 'high' });
    // last seen before the window counts as observed no too
    const old = eventFacts(
      inputs(code(), observed({ events: { order_completed: seenLongAgo } })),
      'order_completed',
    );
    expect(old.status).toBe('dead');
    expect(old.basis).toBe('high');
  });

  it('code no, observed yes: produced elsewhere, live with an info line', () => {
    const r = eventFacts(
      inputs(code(), observed({ events: { order_completed: seenRecently } })),
      'order_completed',
    );
    expect(r).toEqual({ code: 'no', observed: 'yes', status: 'live', producedElsewhere: true });
  });

  it('code no, observed unknown (no observed): dead, code only', () => {
    const r = eventFacts(inputs(code()), 'order_completed');
    expect(r).toEqual({ code: 'no', observed: 'unknown', status: 'dead', basis: 'code-only' });
    // observed present but this event not read is unknown too
    const unread = eventFacts(inputs(code(), observed()), 'order_completed');
    expect(unread.basis).toBe('code-only');
  });

  it('code yes, observed no: live plus "not arriving", with enforcement when it is reject', () => {
    const c = code({ events: { book_previewed: fact('yes') } });
    const allow = eventFacts(
      inputs(c, observed({ events: { book_previewed: { ...seenLongAgo, enforcement: 'allow' } } })),
      'book_previewed',
    );
    expect(allow).toEqual({ code: 'yes', observed: 'no', status: 'live', notArriving: {} });
    const reject = eventFacts(
      inputs(
        c,
        observed({ events: { book_previewed: { defined: false, enforcement: 'reject' } } }),
      ),
      'book_previewed',
    );
    expect(reject.notArriving).toEqual({ enforcement: 'reject' });
    expect(reject.status).toBe('live');
  });

  it('code yes, observed yes or unknown: live', () => {
    const c = code({ events: { book_previewed: fact('yes') } });
    expect(
      eventFacts(
        inputs(c, observed({ events: { book_previewed: seenRecently } })),
        'book_previewed',
      ),
    ).toEqual({ code: 'yes', observed: 'yes', status: 'live' });
    expect(eventFacts(inputs(c), 'book_previewed')).toEqual({
      code: 'yes',
      observed: 'unknown',
      status: 'live',
    });
  });

  it('code unknown, observed no: dead only when PostHog has no definition, else not checked', () => {
    const c = code({ events: { gift_card_redeemed: fact('unknown', ['open-event-name']) } });
    const undefinedEvent = eventFacts(
      inputs(c, observed({ events: { gift_card_redeemed: { defined: false } } })),
      'gift_card_redeemed',
    );
    expect(undefinedEvent).toEqual({
      code: 'unknown',
      observed: 'no',
      status: 'dead',
      basis: 'not-defined',
    });
    const definedNotSeen = eventFacts(
      inputs(c, observed({ events: { gift_card_redeemed: seenLongAgo } })),
      'gift_card_redeemed',
    );
    expect(definedNotSeen).toEqual({
      code: 'unknown',
      observed: 'no',
      status: 'not-checked',
      reasons: ['open-event-name'],
    });
  });

  it('code unknown, observed yes: live', () => {
    const c = code({ events: { gift_card_redeemed: fact('unknown') } });
    expect(
      eventFacts(
        inputs(c, observed({ events: { gift_card_redeemed: seenRecently } })),
        'gift_card_redeemed',
      ),
    ).toEqual({ code: 'unknown', observed: 'yes', status: 'live' });
  });

  it('code unknown, observed unknown: not checked with the code reasons, sorted', () => {
    const c = code({
      events: { gift_card_redeemed: fact('unknown', ['open-event-name', 'crashed-file']) },
    });
    expect(eventFacts(inputs(c), 'gift_card_redeemed')).toEqual({
      code: 'unknown',
      observed: 'unknown',
      status: 'not-checked',
      reasons: ['crashed-file', 'open-event-name'],
    });
    // defined, but never given a last-seen time: unknown, so still not checked
    const noTime = eventFacts(
      inputs(c, observed({ events: { gift_card_redeemed: { defined: true, lastSeenAt: null } } })),
      'gift_card_redeemed',
    );
    expect(noTime.status).toBe('not-checked');
  });

  it('an event named like an Object prototype key is an ordinary name', () => {
    const r = eventFacts(inputs(code(), observed()), 'constructor');
    expect(r.status).toBe('dead');
    expect(r.basis).toBe('code-only');
    const c = code({ events: { toString: fact('unknown') } });
    expect(eventFacts(inputs(c, observed()), 'toString').status).toBe('not-checked');
  });
});

describe('D9: below 70% name resolution, no event-level dead from code alone', () => {
  it('a provider that already applies D9 keeps the rate in the reason', () => {
    const c = code({
      events: { order_completed: fact('unknown', [LOW_NAME_RESOLUTION]) },
      rates: [0.69, 0.95],
    });
    expect(eventFacts(inputs(c), 'order_completed')).toEqual({
      code: 'unknown',
      observed: 'unknown',
      status: 'not-checked',
      reasons: [LOW_NAME_RESOLUTION],
      nameResolutionRate: 0.69,
    });
  });

  it('a provider that says "no" at 69% still gives not checked, never dead', () => {
    const c = code({ rates: [0.95, 0.69, 0.5] });
    const r = eventFacts(inputs(c), 'order_completed');
    expect(r.status).toBe('not-checked');
    expect(r.reasons).toEqual([LOW_NAME_RESOLUTION]);
    expect(r.nameResolutionRate).toBe(0.5);
    const at69 = eventFacts(inputs(code({ rates: [0.69] })), 'order_completed');
    expect(at69).toEqual({
      code: 'unknown',
      observed: 'unknown',
      status: 'not-checked',
      reasons: [LOW_NAME_RESOLUTION],
      nameResolutionRate: 0.69,
    });
    // observed data can still decide
    const notDefined = eventFacts(
      inputs(c, observed({ events: { order_completed: { defined: false } } })),
      'order_completed',
    );
    expect(notDefined).toMatchObject({ status: 'dead', basis: 'not-defined' });
    const definedNotSeen = eventFacts(
      inputs(c, observed({ events: { order_completed: seenLongAgo } })),
      'order_completed',
    );
    expect(definedNotSeen.status).toBe('not-checked');
    const seen = eventFacts(
      inputs(c, observed({ events: { order_completed: seenRecently } })),
      'order_completed',
    );
    expect(seen.status).toBe('live');
  });

  it('exactly 70% may give a code-only dead; a rate that is not a number never does', () => {
    expect(eventFacts(inputs(code({ rates: [0.7] })), 'order_completed').status).toBe('dead');
    expect(eventFacts(inputs(code({ rates: [Number.NaN] })), 'order_completed').status).toBe(
      'not-checked',
    );
  });

  it('an event the code sends stays live at a low rate', () => {
    const c = code({ events: { order_completed: fact('yes') }, rates: [0.4] });
    expect(eventFacts(inputs(c), 'order_completed')).toEqual({
      code: 'yes',
      observed: 'unknown',
      status: 'live',
    });
  });

  // The spec's negative control, through the real merge: one source at 69%.
  it('negative control: a merged source at 69% never yields an event-level dead from code alone', () => {
    const low = catalog(0.69);
    const merged = mergeCatalogs([low], new Map());
    const provider: CodeFacts = {
      event: (n) => eventFact(merged, n),
      property: (e, k) => propertyFact(merged, e, k),
      personProperty: (k) => personPropertyFact(merged, k),
      nameResolutionRates: merged.sources.map((s) => s.catalog.coverage.nameResolutionRate),
    };
    const r = eventFacts(inputs(provider), 'gift_card_redeemed');
    expect(r.status).toBe('not-checked');
    expect(r.reasons).toContain(LOW_NAME_RESOLUTION);
    expect(r.nameResolutionRate).toBe(0.69);
    // the same catalog at 70% gives the code-only dead
    const ok = mergeCatalogs([catalog(0.7)], new Map());
    const okProvider: CodeFacts = {
      ...provider,
      event: (n) => eventFact(ok, n),
      nameResolutionRates: [0.7],
    };
    expect(eventFacts(inputs(okProvider), 'gift_card_redeemed')).toMatchObject({
      status: 'dead',
      basis: 'code-only',
    });
  });
});

describe('6.7.1 property table ("ever seen on this event" as observed)', () => {
  const props = (event: string, seen: string[], notSeen: string[]): Observed =>
    observed({
      events: { [event]: seenRecently },
      eventProperties: { [event]: { seen, notSeen } },
    });
  const card = { presence: 'always' as const, values: { kind: 'finite' as const, set: ['card'] } };

  it('code no, observed no: not sent (high)', () => {
    const r = propertyFacts(
      inputs(code(), props('order_completed', [], ['genre'])),
      'order_completed',
      'genre',
    );
    expect(r).toEqual({ code: 'no', observed: 'no', sent: 'no', basis: 'high' });
  });

  it('code no, observed yes: sent elsewhere', () => {
    const r = propertyFacts(
      inputs(code(), props('order_completed', ['genre'], [])),
      'order_completed',
      'genre',
    );
    expect(r).toEqual({ code: 'no', observed: 'yes', sent: 'yes', producedElsewhere: true });
  });

  it('code no, observed unknown: not sent, code only', () => {
    expect(propertyFacts(inputs(code()), 'order_completed', 'genre')).toEqual({
      code: 'no',
      observed: 'unknown',
      sent: 'no',
      basis: 'code-only',
    });
    // a key PostHog does not record is in neither list
    const skipped = propertyFacts(
      inputs(code(), props('order_completed', [], [])),
      'order_completed',
      '$ip',
    );
    expect(skipped.basis).toBe('code-only');
  });

  it('code yes, observed no: sent, never seen by PostHog', () => {
    const c = code({
      properties: { 'order_completed.payment_method': { ...fact('yes'), property: card } },
    });
    const r = propertyFacts(
      inputs(c, props('order_completed', [], ['payment_method'])),
      'order_completed',
      'payment_method',
    );
    expect(r).toEqual({
      code: 'yes',
      observed: 'no',
      sent: 'yes',
      notArriving: true,
      property: card,
    });
  });

  it('code yes, observed yes or unknown: sent, with the code facts', () => {
    const c = code({
      properties: { 'order_completed.payment_method': { ...fact('yes'), property: card } },
    });
    expect(
      propertyFacts(
        inputs(c, props('order_completed', ['payment_method'], [])),
        'order_completed',
        'payment_method',
      ),
    ).toEqual({ code: 'yes', observed: 'yes', sent: 'yes', property: card });
    expect(propertyFacts(inputs(c), 'order_completed', 'payment_method')).toEqual({
      code: 'yes',
      observed: 'unknown',
      sent: 'yes',
      property: card,
    });
  });

  it('code unknown, observed no: not sent only when the event itself arrives', () => {
    const c = code({
      properties: { 'order_completed.format': fact('unknown', ['open-properties']) },
    });
    expect(
      propertyFacts(
        inputs(c, props('order_completed', [], ['format'])),
        'order_completed',
        'format',
      ),
    ).toEqual({ code: 'unknown', observed: 'no', sent: 'no', basis: 'observed' });
    // the event was last seen before the window: the property stays unknown
    const stale = observed({
      events: { order_completed: seenLongAgo },
      eventProperties: { order_completed: { seen: [], notSeen: ['format'] } },
    });
    expect(propertyFacts(inputs(c, stale), 'order_completed', 'format')).toEqual({
      code: 'unknown',
      observed: 'no',
      sent: 'unknown',
      reasons: ['open-properties'],
    });
  });

  it('code unknown, observed yes: sent', () => {
    const c = code({
      properties: { 'order_completed.format': fact('unknown', ['open-properties']) },
    });
    expect(
      propertyFacts(
        inputs(c, props('order_completed', ['format'], [])),
        'order_completed',
        'format',
      ),
    ).toEqual({ code: 'unknown', observed: 'yes', sent: 'yes' });
  });

  it('code unknown, observed unknown: unknown with the code reasons', () => {
    const c = code({
      properties: {
        'order_completed.format': fact('unknown', ['open-super-properties', 'crashed-file']),
      },
    });
    expect(propertyFacts(inputs(c), 'order_completed', 'format')).toEqual({
      code: 'unknown',
      observed: 'unknown',
      sent: 'unknown',
      reasons: ['crashed-file', 'open-super-properties'],
    });
  });
});

describe('6.6 person scope', () => {
  const persons = (seen: string[], notSeen: string[]): Observed =>
    observed({ personProperties: { seen, notSeen } });

  it('set in code: sent in both profiles', () => {
    const c = code({ person: { reader_tier: fact('yes') } });
    for (const p of [posthogProfile, genericProfile])
      expect(personPropertyFacts(inputs(c), 'reader_tier', p)).toEqual({
        code: 'yes',
        observed: 'unknown',
        sent: 'yes',
      });
    expect(
      personPropertyFacts(inputs(c, persons([], ['reader_tier'])), 'reader_tier', posthogProfile),
    ).toMatchObject({ sent: 'yes', notArriving: true });
  });

  it('posthog: "no" only when no catalog sets it and observed person properties lack it', () => {
    expect(
      personPropertyFacts(
        inputs(code(), persons([], ['reader_tier'])),
        'reader_tier',
        posthogProfile,
      ),
    ).toEqual({ code: 'no', observed: 'no', sent: 'no', basis: 'high' });
    expect(
      personPropertyFacts(
        inputs(code(), persons(['reader_tier'], [])),
        'reader_tier',
        posthogProfile,
      ),
    ).toEqual({ code: 'no', observed: 'yes', sent: 'yes', producedElsewhere: true });
    // observed data present but the person list not read, or the key in neither list: unknown
    expect(personPropertyFacts(inputs(code(), observed()), 'reader_tier', posthogProfile)).toEqual({
      code: 'no',
      observed: 'unknown',
      sent: 'unknown',
      reasons: [PERSON_NOT_OBSERVED],
    });
    expect(
      personPropertyFacts(inputs(code(), persons([], [])), 'reader_tier', posthogProfile).sent,
    ).toBe('unknown');
    // no observed data at all: code only, as for events
    expect(personPropertyFacts(inputs(code()), 'reader_tier', posthogProfile)).toEqual({
      code: 'no',
      observed: 'unknown',
      sent: 'no',
      basis: 'code-only',
    });
  });

  it('generic: "no" when no catalog sets it, whatever was observed', () => {
    expect(personPropertyFacts(inputs(code(), observed()), 'reader_tier', genericProfile)).toEqual({
      code: 'no',
      observed: 'unknown',
      sent: 'no',
      basis: 'code-only',
    });
    expect(
      personPropertyFacts(
        inputs(code(), persons(['reader_tier'], [])),
        'reader_tier',
        genericProfile,
      ).sent,
    ).toBe('yes');
  });

  it('code unknown stays unknown unless observed', () => {
    const c = code({ person: { reader_tier: fact('unknown', ['open-person-properties']) } });
    for (const p of [posthogProfile, genericProfile]) {
      expect(
        personPropertyFacts(inputs(c, persons([], ['reader_tier'])), 'reader_tier', p),
      ).toEqual({
        code: 'unknown',
        observed: 'no',
        sent: 'unknown',
        reasons: ['open-person-properties'],
      });
      expect(
        personPropertyFacts(inputs(c, persons(['reader_tier'], [])), 'reader_tier', p).sent,
      ).toBe('yes');
    }
  });
});

describe('factInputs', () => {
  it('reads observed and pulledAt from the requirements', () => {
    const c = code();
    const base: Requirements = {
      schema: 'dashlint.requirements/1',
      source: { platform: 'posthog' },
      tiles: [],
    };
    expect(factInputs(base, c)).toEqual({ code: c });
    const o = observed();
    expect(
      factInputs({ ...base, source: { platform: 'posthog', pulledAt: PULLED }, observed: o }, c),
    ).toEqual({
      code: c,
      observed: o,
      pulledAt: PULLED,
    });
  });
});

/** One closed source with a name-resolution rate; it sends `order_completed` only. */
function catalog(rate: number): Catalog {
  const c: Catalog = {
    schema: 'dashlint.catalog/1',
    tool: '0.0.0-test',
    source: {
      name: 'web',
      root: 'web',
      commit: null,
      platforms: ['web'],
      sdks: [{ id: 'shop-sdk', version: '1.0.0', types: 'stub' }],
    },
    openWorld: [],
    events: {
      order_completed: {
        sites: [
          {
            file: 'src/cart.ts',
            line: 3,
            sdk: 'shop-sdk',
            via: [],
            platforms: ['web'],
            openProperties: false,
          },
        ],
        openSites: 0,
        properties: {},
      },
    },
    superProperties: {},
    personProperties: {},
    builtins: { events: [], properties: null, conditional: [], off: [] },
    identity: [],
    coverage: {
      files: 3,
      excludedFiles: 0,
      oversizeFiles: 0,
      crashedFiles: 0,
      callSites: 100,
      literalNameSites: Math.round(rate * 100),
      openSites: 0,
      nameResolutionRate: rate,
      openSuperSites: 0,
      openPersonSites: 0,
    },
  };
  const v = validateCatalog(c);
  if (!v.ok) throw new Error(`invalid test catalog: ${JSON.stringify(v.errors)}`);
  return c;
}
