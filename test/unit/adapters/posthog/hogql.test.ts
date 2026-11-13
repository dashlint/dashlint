// Opt-in HogQL property recency (T5.6): aggregate queries only, answers replayed from the demo
// project's recording (scripts/record-demo-hogql.mjs), no POST at all without the opt-in.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { PostHogClient, PullError } from '../../../../src/adapters/posthog/client.js';
import {
  applyRecency,
  askRecency,
  assertAggregateOnly,
  KEYS_PER_QUERY,
  parseRecency,
  propertyRecency,
  recencyQuery,
} from '../../../../src/adapters/posthog/hogql.js';
import { pullRequirements, requirementsJson } from '../../../../src/adapters/posthog/pull.js';
import type { Observed } from '../../../../src/formats/requirements.js';
import { validateRequirements } from '../../../../src/formats/validate.js';
import { startMock, type MockServer, type Route } from './mock-server.js';

type Responses = Record<string, unknown>;
interface RecordedQuery {
  request: { query: unknown };
  status: number;
  answer: unknown;
}

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../fixtures/posthog-recorded/${name}`, import.meta.url), 'utf8'),
  );
const definitions = fixture('demo.json') as {
  recorded: { host: string; project: number };
  responses: Responses;
};
const hogql = fixture('demo-hogql.json') as {
  recorded: { by: string; host: string; project: number; windowDays: number };
  queries: RecordedQuery[];
};
const { project } = definitions.recorded;
const P = `/api/projects/${project}`;
const KEY = 'phx_hogql_test_only';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** The demo project on the mock server: recorded definitions, and recorded answers by request body. */
function demoRoutes(
  answer: (body: string) => { status?: number; body: unknown } = recordedAnswer,
): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const [rel, body] of Object.entries(definitions.responses))
    routes[`GET ${P}/${rel}`] = () => ({ body });
  routes[`POST ${P}/query/`] = (req) => answer(req.body);
  return routes;
}

function recordedAnswer(body: string): { status?: number; body: unknown } {
  const hit = hogql.queries.find((q) => JSON.stringify(q.request) === body);
  return hit
    ? { status: hit.status, body: hit.answer }
    : { status: 400, body: { detail: 'not recorded' } };
}

async function pullOn(base: string, extra: { hogql?: boolean; observedDays?: number } = {}) {
  return pullRequirements({
    host: base,
    project,
    key: KEY,
    tool: '0.0.0-test',
    info: () => {},
    now: () => Date.parse('2026-11-13T12:00:00Z'),
    ...extra,
  });
}

function client(base: string, hogqlOn = true): PostHogClient {
  return new PostHogClient({ host: base, project: 42, key: KEY, hogql: hogqlOn, info: () => {} });
}

describe('HogQL recency on the recorded demo project', () => {
  it('was recorded from the demo project by the recorder, every request an aggregate', () => {
    expect(hogql.recorded.by).toBe('scripts/record-demo-hogql.mjs');
    expect(hogql.recorded.project).toBe(project);
    expect(hogql.queries.length).toBeGreaterThan(0);
    for (const q of hogql.queries) {
      expect(() => assertAggregateOnly(q.request.query)).not.toThrow();
      expect(q.status).toBe(200);
    }
  });

  it('with hogql: true asks each recorded query once, aggregates only, and writes valid requirements', async () => {
    server = await startMock(demoRoutes());
    const r = await pullOn(server.base, { hogql: true });
    const posts = server.received.filter((x) => x.method === 'POST');
    expect(posts.map((x) => x.url)).toEqual(hogql.queries.map(() => `${P}/query/`));
    expect(posts.map((x) => JSON.parse(x.body) as unknown)).toEqual(
      hogql.queries.map((q) => q.request),
    );
    expect(server.received.filter((x) => x.method !== 'GET' && x.method !== 'POST')).toEqual([]);
    expect(validateRequirements(JSON.parse(requirementsJson(r))).ok).toBe(true);
    // The demo's answers: arrived inside the window, or the empty maximum (1970-01-01).
    expect(r.observed?.eventProperties).toEqual({
      book_viewed: { seen: [], notSeen: ['genre'] },
      order_completed: { seen: ['total'], notSeen: ['format'] },
      order_completed_native: { seen: ['total'], notSeen: ['gift_wrap'] },
      payment_method_selected: { seen: ['payment_method'], notSeen: [] },
    });
  });

  it('with hogql: false (or unset) no POST is made on the mock server', async () => {
    for (const extra of [{}, { hogql: false }]) {
      server = await startMock(demoRoutes());
      const r = await pullOn(server.base, extra);
      expect(server.received.length).toBeGreaterThan(5);
      expect(new Set(server.received.map((x) => x.method))).toEqual(new Set(['GET']));
      expect(Object.keys(r.observed?.eventProperties ?? {}).length).toBeGreaterThan(0);
      await server.close();
      server = undefined;
    }
  });

  it('a recency answer replaces the ever-seen fact: seen long ago becomes not seen, and back', async () => {
    const flipped = (body: string) => {
      const { query } = JSON.parse(body) as { query: { values: Record<string, string> } };
      const cells = Object.keys(query.values)
        .filter((k) => k !== 'e')
        .map((k) =>
          query.values[k] === 'total' ? '1970-01-01T00:00:00Z' : '2026-11-12T08:00:00.5Z',
        );
      return { body: { results: [cells], error: null } };
    };
    server = await startMock(demoRoutes(flipped));
    const r = await pullOn(server.base, { hogql: true, observedDays: 7 });
    expect(
      JSON.parse(server.received.find((x) => x.method === 'POST')?.body ?? '{}'),
    ).toMatchObject({
      query: { query: expect.stringMatching(/INTERVAL 7 DAY$/) as unknown },
    });
    expect(r.observed?.eventProperties).toEqual({
      book_viewed: { seen: ['genre'], notSeen: [] },
      order_completed: { seen: ['format'], notSeen: ['total'] },
      order_completed_native: { seen: ['gift_wrap'], notSeen: ['total'] },
      payment_method_selected: { seen: ['payment_method'], notSeen: [] },
    });
  });

  it('a missing query:read scope stops the pull with exit 4 naming it', async () => {
    server = await startMock(
      demoRoutes(() => ({
        status: 403,
        body: { detail: "API key missing required scope 'query:read'" },
      })),
    );
    const e = await pullOn(server.base, { hogql: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PullError);
    expect((e as PullError).exitCode).toBe(4);
    expect((e as PullError).message).toContain('missing the scope query:read');
  });
});

describe('recency queries', () => {
  it('names travel as placeholders, the window is whole days, 1 to KEYS_PER_QUERY keys', () => {
    expect(recencyQuery("it's", ['a "b"', 'c'], 30)).toEqual({
      kind: 'HogQLQuery',
      query:
        'SELECT maxIf(timestamp, JSONHas(properties, {p0})), maxIf(timestamp, JSONHas(properties, {p1})) FROM events WHERE event = {e} AND timestamp >= now() - INTERVAL 30 DAY',
      values: { e: "it's", p0: 'a "b"', p1: 'c' },
    });
    expect(() => recencyQuery('e', ['a'], 0)).toThrow(RangeError);
    expect(() => recencyQuery('e', ['a'], 1.5)).toThrow(RangeError);
    expect(() => recencyQuery('e', [], 30)).toThrow(RangeError);
    const many = Array.from({ length: KEYS_PER_QUERY + 1 }, (_, i) => `k${i}`);
    expect(() => recencyQuery('e', many, 30)).toThrow(RangeError);
    expect(() => assertAggregateOnly(recencyQuery('e', many.slice(1), 30))).not.toThrow();
  });

  it('an event with more than KEYS_PER_QUERY properties is asked in several queries', async () => {
    const keys = Array.from(
      { length: KEYS_PER_QUERY + 1 },
      (_, i) => `k${String(i).padStart(2, '0')}`,
    );
    const tile = {
      id: 'insight:t',
      title: 't',
      kind: 'trends' as const,
      series: [
        {
          ref: 'A',
          node: 'event' as const,
          event: 'order_completed',
          filters: keys.map((key) => ({ key, scope: 'event' as const, op: 'is_set', values: [] })),
        },
      ],
    };
    server = await startMock({
      [`POST /api/projects/42/query/`]: (req) => {
        const n = (JSON.parse(req.body) as { query: { values: object } }).query.values;
        const cells = Object.keys(n)
          .slice(1)
          .map(() => '2026-11-12T00:00:00Z');
        return { body: { results: [cells] } };
      },
    });
    const recency = await propertyRecency(client(server.base), { tiles: [tile] }, 30);
    expect(
      server.received.map(
        (x) =>
          Object.keys((JSON.parse(x.body) as { query: { values: object } }).query.values).length,
      ),
    ).toEqual([KEYS_PER_QUERY + 1, 2]);
    expect([...(recency.get('order_completed')?.keys() ?? [])]).toEqual(keys);
  });

  it('negative control: a query that selects rows is refused before it is sent (exit 3)', async () => {
    server = await startMock({ [`POST /api/projects/42/query/`]: { body: { results: [] } } });
    const good = recencyQuery('order_completed', ['total'], 30);
    const two = recencyQuery('order_completed', ['total', 'format'], 30);
    const three = recencyQuery('order_completed', ['total', 'format', 'channel'], 30);
    const bad: [string, unknown][] = [
      ['every column', { ...good, query: 'SELECT * FROM events' }],
      [
        'raw timestamps',
        {
          ...good,
          query: good.query.replace('maxIf(timestamp, JSONHas(properties, {p0}))', 'timestamp'),
        },
      ],
      ['properties', { ...good, query: good.query.replace('SELECT ', 'SELECT properties, ') }],
      ['person ids', { ...good, query: good.query.replace('SELECT ', 'SELECT distinct_id, ') }],
      ['a group by', { ...good, query: `${good.query} GROUP BY distinct_id` }],
      ['a second statement', { ...good, query: `${good.query}; SELECT * FROM events` }],
      ['a limit', { ...good, query: `${good.query} LIMIT 100` }],
      ['another table', { ...good, query: good.query.replace('FROM events', 'FROM persons') }],
      [
        'a spliced name',
        { ...good, query: good.query.replace('{e}', "'order_completed'"), values: { p0: 'total' } },
      ],
      ['an extra value', { ...good, values: { ...good.values, p1: 'x' } }],
      ['a missing value', { ...good, values: { e: 'order_completed' } }],
      ['a value not text', { ...good, values: { e: 'order_completed', p0: 7 } }],
      [
        'placeholders out of order',
        { ...good, query: good.query.replace('{p0}', '{p1}'), values: { e: 'x', p1: 'total' } },
      ],
      [
        'a skipped placeholder',
        {
          ...two,
          query: two.query.replace('{p1}', '{p2}'),
          values: { e: 'x', p0: 'total', p2: 'format' },
        },
      ],
      [
        'swapped placeholders (answers would land on the wrong keys)',
        {
          ...three,
          query: three.query
            .replace('{p1}', '{pX}')
            .replace('{p2}', '{p1}')
            .replace('{pX}', '{p2}'),
        },
      ],
      ['no values', { kind: 'HogQLQuery', query: good.query }],
      ['an extra field', { ...good, refresh: 'force_blocking' }],
      ['another kind', { ...good, kind: 'EventsQuery' }],
      ['not an object', 'SELECT 1'],
    ];
    for (const [label, q] of bad) {
      const e = await askRecency(client(server.base), q).catch((x: unknown) => x);
      expect(e, label).toBeInstanceOf(PullError);
      expect((e as PullError).exitCode, label).toBe(3);
      expect((e as PullError).message, label).toContain('refused a HogQL query before sending it');
    }
    expect(server.received).toEqual([]);
    await askRecency(client(server.base), good);
    expect(server.received).toHaveLength(1);
  });

  it('without the opt-in the client refuses even a good query, and nothing is sent', async () => {
    server = await startMock({ [`POST /api/projects/42/query/`]: { body: { results: [[null]] } } });
    const e = await askRecency(client(server.base, false), recencyQuery('e', ['p'], 30)).catch(
      (x: unknown) => x,
    );
    expect((e as PullError).exitCode).toBe(3);
    expect(server.received).toEqual([]);
  });
});

describe('recency answers', () => {
  it('a time is seen, the empty maximum or null is not seen, anything else says nothing', () => {
    expect(
      parseRecency(
        {
          results: [
            [
              '2026-11-13T10:31:11.255000Z',
              '1970-01-01T00:00:00Z',
              '1970-01-01T00:00:00.000000Z',
              null,
              7,
              'soon',
              '1970-01-02T00:00:00Z',
            ],
          ],
        },
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      ),
    ).toEqual([true, false, false, false, undefined, undefined, true]);
  });

  it.each([
    ['not an object', null],
    ['an error', { error: 'Query timed out', results: [[null]] }],
    ['no results', {}],
    ['no row', { results: [] }],
    ['two rows', { results: [[null], [null]] }],
    ['a row not a list', { results: [{ a: 1 }] }],
    ['too few cells', { results: [[]] }],
    ['too many cells', { results: [[null, null]] }],
  ])('an unexpected answer (%s) stops the pull with exit 4', (_label, body) => {
    let e: unknown;
    try {
      parseRecency(body, ['a']);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(PullError);
    expect((e as PullError).exitCode).toBe(4);
    expect((e as PullError).message).toContain('HogQL recency query');
  });
});

describe('applying recency to observed', () => {
  const observed: Observed = {
    windowDays: 30,
    events: {},
    eventProperties: {
      a_event: { seen: ['kept', 'old'], notSeen: ['gone', 'late'] },
      z_event: { seen: ['x'], notSeen: [] },
    },
  };

  it('answers replace facts, unanswered keys keep theirs, new events get an entry in code-point order', () => {
    const recency = new Map([
      [
        'a_event',
        new Map([
          ['old', false],
          ['late', true],
          ['new', false],
        ]),
      ],
      ['__proto__', new Map([['p', true]])],
    ]);
    const out = applyRecency(observed, recency);
    expect(Object.keys(out.eventProperties ?? {})).toEqual(['__proto__', 'a_event', 'z_event']);
    expect(Object.hasOwn(out.eventProperties ?? {}, '__proto__')).toBe(true);
    expect(out.eventProperties?.a_event).toEqual({
      seen: ['kept', 'late'],
      notSeen: ['gone', 'new', 'old'],
    });
    expect(out.eventProperties?.z_event).toEqual({ seen: ['x'], notSeen: [] });
    expect(Object.getOwnPropertyDescriptor(out.eventProperties, '__proto__')?.value).toEqual({
      seen: ['p'],
      notSeen: [],
    });
    expect(out.windowDays).toBe(30);
    expect(observed.eventProperties?.a_event).toEqual({
      seen: ['kept', 'old'],
      notSeen: ['gone', 'late'],
    });
  });

  it('no answers leave observed as it was; observed without eventProperties gains them', () => {
    expect(applyRecency(observed, new Map())).toBe(observed);
    const bare: Observed = { windowDays: 30, events: {} };
    expect(applyRecency(bare, new Map([['e', new Map([['p', false]])]]))).toEqual({
      windowDays: 30,
      events: {},
      eventProperties: { e: { seen: [], notSeen: ['p'] } },
    });
  });
});
