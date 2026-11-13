import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_429_RETRIES,
  MAX_IN_FLIGHT,
  MAX_RETRY_AFTER_SECONDS,
  PER_MINUTE,
  PostHogClient,
  PullError,
  dropOnArrival,
  resolveKey,
  type ClientOptions,
} from '../../../../src/adapters/posthog/client.js';
import { startMock, type MockServer } from './mock-server.js';

const KEY = 'phx_TestOnlyKey_7f3a9c21d4e8b6';
const P = '/api/projects/42';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

interface Captured {
  info: string[];
  debug: string[];
  sleeps: number[];
}

function client(
  base: string,
  extra: Partial<ClientOptions> = {},
): { c: PostHogClient; out: Captured } {
  const out: Captured = { info: [], debug: [], sleeps: [] };
  const c = new PostHogClient({
    host: base,
    project: 42,
    key: KEY,
    info: (l) => out.info.push(l),
    debug: (l) => out.debug.push(l),
    sleep: async (ms) => {
      out.sleeps.push(ms);
    },
    ...extra,
  });
  return { c, out };
}

async function failure(p: Promise<unknown>): Promise<PullError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PullError) return e;
    throw e;
  }
  throw new Error('expected a PullError');
}

describe('pagination', () => {
  it('adds limit=100, follows next on the same host and project, keeps the order', async () => {
    server = await startMock({
      [`GET ${P}/insights/?saved=true&limit=100`]: (_r, base) => ({
        body: {
          next: `${base}${P}/insights/?limit=100&offset=100&saved=true`,
          results: [{ id: 1 }, { id: 2 }],
        },
      }),
      [`GET ${P}/insights/?limit=100&offset=100&saved=true`]: {
        body: { next: null, results: [{ id: 3 }] },
      },
    });
    const { c, out } = client(server.base);
    expect(await c.getAll('insights/?saved=true')).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(server.received.map((r) => r.url)).toEqual([
      `${P}/insights/?saved=true&limit=100`,
      `${P}/insights/?limit=100&offset=100&saved=true`,
    ]);
    expect(server.received.every((r) => r.method === 'GET')).toBe(true);
    expect(c.requests).toBe(2);
    // The host is printed once, before the first request.
    expect(out.info).toEqual([
      `pull: reading definitions from ${server.base}, project 42 (GET only)`,
    ]);
  });

  it('keeps an explicit limit and yields each page with its relative path', async () => {
    server = await startMock({
      [`GET ${P}/event_definitions/?limit=2`]: (_r, base) => ({
        body: {
          next: `${base}${P}/event_definitions/?limit=2&offset=2`,
          results: [{ name: 'a' }, { name: 'b' }],
        },
      }),
      [`GET ${P}/event_definitions/?limit=2&offset=2`]: {
        body: { next: '', results: [{ name: 'c' }] },
      },
    });
    const { c } = client(server.base);
    const paths: string[] = [];
    for await (const page of c.pages('event_definitions/?limit=2')) paths.push(page.path);
    expect(paths).toEqual(['event_definitions/?limit=2', 'event_definitions/?limit=2&offset=2']);
  });

  it('stops when next points to another host or another project', async () => {
    for (const next of [
      'https://elsewhere.example/api/projects/42/insights/?offset=100',
      `{base}/api/projects/43/insights/`,
    ]) {
      server = await startMock({
        [`GET ${P}/insights/?limit=100`]: (_r, base) => ({
          body: { next: next.replace('{base}', base), results: [] },
        }),
      });
      const { c } = client(server.base);
      const e = await failure(c.getAll('insights/'));
      expect(e.exitCode).toBe(4);
      expect(e.message).toMatch(/next-page link points away/);
      expect(server.received).toHaveLength(1);
      await server.close();
      server = undefined;
    }
  });

  it('refuses a list page with no results', async () => {
    server = await startMock({ [`GET ${P}/alerts/?limit=100`]: { body: { detail: 'odd' } } });
    const e = await failure(client(server.base).c.getAll('alerts/'));
    expect(e.exitCode).toBe(4);
    expect(e.message).toBe(`GET ${P}/alerts/ did not return a list (no "results")`);
  });
});

describe('429 and Retry-After', () => {
  it('waits Retry-After seconds, then retries', async () => {
    server = await startMock({
      [`GET ${P}/dashboards/7/`]: [
        {
          status: 429,
          headers: { 'retry-after': '2' },
          body: { detail: 'Request was throttled.' },
        },
        { body: { id: 7 } },
      ],
    });
    const { c, out } = client(server.base);
    expect(await c.get('dashboards/7/')).toEqual({ id: 7 });
    expect(out.sleeps).toEqual([2000]);
    expect(server.received).toHaveLength(2);
    expect(out.info).toContain(
      `pull: rate limited on ${P}/dashboards/7/, waiting 2 s (Retry-After)`,
    );
  });

  it('reads an HTTP-date Retry-After, and the detail when the header is missing', async () => {
    const now = Date.parse('2026-11-13T10:00:00Z');
    server = await startMock({
      [`GET ${P}/alerts/`]: [
        { status: 429, headers: { 'retry-after': 'Fri, 13 Nov 2026 10:00:05 GMT' } },
        {
          status: 429,
          body: { detail: 'Request was throttled. Expected available in 7 seconds.' },
        },
        { status: 429 },
        { body: { ok: true } },
      ],
    });
    const { c, out } = client(server.base, { now: () => now });
    expect(await c.get('alerts/')).toEqual({ ok: true });
    expect(out.sleeps).toEqual([5000, 7000, 60000]);
  });

  it(`gives up after ${MAX_429_RETRIES} waits with exit 4 and the endpoint named`, async () => {
    server = await startMock({
      [`GET ${P}/actions/5/`]: { status: 429, headers: { 'retry-after': '1' } },
    });
    const { c, out } = client(server.base);
    const e = await failure(c.get('actions/5/'));
    expect(e.exitCode).toBe(4);
    expect(e.message).toBe(`GET ${P}/actions/5/ was still rate limited (HTTP 429) after 3 waits`);
    expect(server.received).toHaveLength(MAX_429_RETRIES + 1);
    expect(out.sleeps).toEqual([1000, 1000, 1000]);
  });

  it('does not wait more than 120 s', async () => {
    server = await startMock({
      [`GET ${P}/alerts/`]: { status: 429, headers: { 'retry-after': '121' } },
    });
    const { c, out } = client(server.base);
    const e = await failure(c.get('alerts/'));
    expect(e.exitCode).toBe(4);
    expect(e.message).toMatch(
      new RegExp(`^GET ${P}/alerts/ was rate limited \\(HTTP 429\\) for 121 s`),
    );
    expect(out.sleeps).toEqual([]);
  });
});

describe('errors', () => {
  it('names the missing scope on 403 (exit 4)', async () => {
    server = await startMock({
      [`GET ${P}/alerts/?limit=100`]: {
        status: 403,
        body: { detail: "API key missing required scope 'alert:read'" },
      },
    });
    const e = await failure(client(server.base).c.getAll('alerts/'));
    expect(e.exitCode).toBe(4);
    expect(e.message).toBe(
      `the PostHog key is missing the scope alert:read (GET ${P}/alerts/ returned HTTP 403); add alert:read to the personal API key`,
    );
  });

  it('maps 401, other 403, 404 and 500 to exit 4 with the endpoint', async () => {
    server = await startMock({
      [`GET ${P}/a/`]: { status: 401, body: { detail: 'Invalid' } },
      [`GET ${P}/b/`]: {
        status: 403,
        body: { detail: 'API key does not have access to the requested organization' },
      },
      [`GET ${P}/c/`]: { status: 404 },
      [`GET ${P}/d/`]: { status: 500, body: 'oops' },
    });
    const { c } = client(server.base);
    const msgs = [];
    for (const p of ['a/', 'b/', 'c/', 'd/']) {
      const e = await failure(c.get(p));
      expect(e.exitCode).toBe(4);
      msgs.push(e.message);
    }
    expect(msgs).toEqual([
      `PostHog refused the key (GET ${P}/a/ returned HTTP 401); check the personal API key`,
      `PostHog denied access (GET ${P}/b/ returned HTTP 403): API key does not have access to the requested organization`,
      `not found (GET ${P}/c/ returned HTTP 404); check the host and the project id`,
      `GET ${P}/d/ returned HTTP 500`,
    ]);
  });

  it('retries 502, 503 and 504 twice with a short backoff', async () => {
    server = await startMock({
      [`GET ${P}/x/`]: [{ status: 503 }, { status: 502 }, { body: { ok: 1 } }],
    });
    const { c, out } = client(server.base);
    expect(await c.get('x/')).toEqual({ ok: 1 });
    expect(out.sleeps).toEqual([1000, 2000]);
    await server.close();
    server = await startMock({ [`GET ${P}/y/`]: { status: 504 } });
    const e = await failure(client(server.base).c.get('y/'));
    expect(e.message).toBe(`GET ${P}/y/ returned HTTP 504`);
    expect(server.received).toHaveLength(3);
  });

  it('retries a network failure twice, then exits 4 naming the host', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { c, out } = client('https://posthog.example', { fetch });
    const e = await failure(c.get('insights/'));
    expect(e.exitCode).toBe(4);
    expect(e.message).toBe(
      'could not reach https://posthog.example for GET /api/projects/42/insights/: fetch failed',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(out.sleeps).toEqual([1000, 2000]);
  });

  it('refuses a 200 that is not JSON', async () => {
    server = await startMock({ [`GET ${P}/x/`]: { body: '<html>login</html>' } });
    const e = await failure(client(server.base).c.get('x/'));
    expect(e.exitCode).toBe(4);
    expect(e.message).toBe(`GET ${P}/x/ returned HTTP 200 but not JSON`);
  });
});

describe('GET only', () => {
  it('refuses every other method before it reaches the network', async () => {
    server = await startMock({});
    const { c } = client(server.base);
    for (const [m, p] of [
      ['POST', 'insights/'],
      ['PATCH', 'insights/1/'],
      ['PUT', 'dashboards/1/'],
      ['DELETE', 'alerts/1/'],
      ['POST', 'query/'],
    ] as const) {
      const e = await failure(c.request(m, p, {}));
      expect(e.exitCode).toBe(3);
      expect(e.message).toBe(
        `refused ${m} ${P}/${p}: dashlint pull only reads (GET), and POSTs only to query/ when hogql is on`,
      );
    }
    expect(server.received).toEqual([]);
  });

  it('with hogql on, POSTs to query/ and nowhere else', async () => {
    server = await startMock({ [`POST ${P}/query/`]: { body: { results: [[1]] } } });
    const { c, out } = client(server.base, { hogql: true });
    expect(await c.query({ query: { kind: 'HogQLQuery', query: 'select 1' } })).toEqual({
      results: [[1]],
    });
    expect(server.received[0]?.body).toBe('{"query":{"kind":"HogQLQuery","query":"select 1"}}');
    expect(out.info[0]).toBe(
      `pull: reading definitions from ${server.base}, project 42 (GET only, and POST query/ for HogQL recency)`,
    );
    const e = await failure(c.request('POST', 'insights/', {}));
    expect(e.exitCode).toBe(3);
    expect((await failure(c.request('DELETE', 'query/'))).exitCode).toBe(3);
    expect(server.received).toHaveLength(1);
  });

  it('refuses paths that leave the project', async () => {
    const { c } = client('https://posthog.example', { fetch: vi.fn() });
    for (const p of [
      '/api/projects/43/',
      '../43/insights/',
      'insights/../../43/',
      'https://evil.example/',
      'a\\b',
    ]) {
      const e = await failure(c.get(p));
      expect(e.exitCode).toBe(3);
    }
  });
});

describe('the key', () => {
  it('is sent only in the Authorization header and never appears in any output', async () => {
    const echo = `bad key ${KEY}`;
    server = await startMock({
      [`GET ${P}/insights/?limit=100`]: (_r, base) => ({
        body: { next: `${base}${P}/insights/?limit=100&offset=1`, results: [] },
      }),
      [`GET ${P}/insights/?limit=100&offset=1`]: [
        { status: 429, headers: { 'retry-after': '1' } },
        { body: { results: [] } },
      ],
      [`GET ${P}/a/`]: { status: 403, body: { detail: echo } },
      [`GET ${P}/b/`]: { status: 500, body: { detail: echo } },
      [`GET ${P}/c/`]: { status: 401, body: { detail: echo } },
    });
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (written.push(String(s)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => (written.push(String(s)), true));
    const consoleSpies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) =>
      vi
        .spyOn(console, m)
        .mockImplementation((...a: unknown[]) => void written.push(a.map(String).join(' '))),
    );
    // Default info (stderr) and a debug sink: everything the client says is captured.
    const debug: string[] = [];
    const c = new PostHogClient({
      host: server.base,
      project: 42,
      key: KEY,
      debug: (l) => debug.push(l),
      sleep: async () => {},
    });
    await c.getAll('insights/');
    const errors: string[] = [];
    for (const p of ['a/', 'b/', 'c/', '../x', 'z/']) {
      const e = await failure(c.get(p));
      errors.push(e.message, String(e.stack));
    }
    const fetch = vi.fn(async () => {
      throw new Error(`socket closed for ${KEY}`);
    });
    const c2 = new PostHogClient({
      host: 'https://posthog.example',
      project: 42,
      key: KEY,
      fetch,
      debug: (l) => debug.push(l),
      sleep: async () => {},
    });
    const e2 = await failure(c2.get('x/'));
    errors.push(e2.message);
    for (const s of consoleSpies) expect(s).not.toHaveBeenCalled();

    // It was sent: every request carried it.
    expect(server.received.length).toBeGreaterThan(5);
    expect(server.received.every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
    // And it was never written: stdout, stderr, debug output, error messages and stacks.
    const all = [...written, ...debug, ...errors].join('\n');
    expect(written.join('')).toContain('pull: reading definitions from');
    expect(debug.some((l) => l.includes('"Authorization":"Bearer [redacted]"'))).toBe(true);
    expect(all).toContain(`bad key [redacted]`);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice(4));
  });

  it('comes only from the environment variable the config names', () => {
    expect(resolveKey('env:DASHLINT_POSTHOG_KEY', { DASHLINT_POSTHOG_KEY: ` ${KEY}\n` })).toBe(KEY);
    const literal = (() => {
      try {
        resolveKey(KEY, { DASHLINT_POSTHOG_KEY: KEY });
      } catch (e) {
        return e as PullError;
      }
      throw new Error('accepted a literal key');
    })();
    expect(literal.exitCode).toBe(2);
    expect(literal.message).toBe(
      'Put the key in an environment variable and write `key: env:NAME`.',
    );
    expect(literal.message).not.toContain(KEY);
    for (const env of [{}, { MY_KEY: '' }, { MY_KEY: '  ' }]) {
      expect(() => resolveKey('env:MY_KEY', env)).toThrow(
        expect.objectContaining({
          exitCode: 4,
          message: 'no PostHog key: the environment variable MY_KEY is not set or empty',
        }),
      );
    }
    expect(() => resolveKey('env:', {})).toThrow(expect.objectContaining({ exitCode: 2 }));
  });
});

describe('politeness', () => {
  it('uses the limits measured in V6 (3 in flight, 240 a minute, 3 waits of at most 120 s)', () => {
    expect([MAX_IN_FLIGHT, PER_MINUTE, MAX_429_RETRIES, MAX_RETRY_AFTER_SECONDS]).toEqual([
      3, 240, 3, 120,
    ]);
  });

  it(`keeps at most ${MAX_IN_FLIGHT} requests in flight`, async () => {
    const routes: Record<string, { body: unknown; delayMs: number }> = {};
    for (let i = 0; i < 12; i++)
      routes[`GET ${P}/actions/${i}/`] = { body: { id: i }, delayMs: 25 };
    server = await startMock(routes);
    const { c } = client(server.base);
    const got = await Promise.all(Array.from({ length: 12 }, (_, i) => c.get(`actions/${i}/`)));
    expect(got).toEqual(Array.from({ length: 12 }, (_, i) => ({ id: i })));
    expect(server.maxInFlight).toBe(MAX_IN_FLIGHT);
  });

  it(`starts at most ${PER_MINUTE} requests in any rolling minute`, async () => {
    let clock = 0;
    const starts: number[] = [];
    const fetch = vi.fn(async () => {
      starts.push(clock);
      clock += 10;
      return new Response('{}', { status: 200 });
    });
    const sleeps: number[] = [];
    const c = new PostHogClient({
      host: 'https://posthog.example',
      project: 1,
      key: KEY,
      fetch,
      info: () => {},
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    for (let i = 0; i < PER_MINUTE + 5; i++) await c.get('event_definitions/');
    expect(fetch).toHaveBeenCalledTimes(PER_MINUTE + 5);
    // Request 241 waits until the first leaves the minute; later ones are 10 ms apart, like the first.
    expect(sleeps).toEqual([60_000 - PER_MINUTE * 10]);
    for (let i = PER_MINUTE; i < starts.length; i++)
      expect((starts[i] as number) - (starts[i - PER_MINUTE] as number)).toBeGreaterThanOrEqual(
        60_000,
      );
  });
});

describe('configuration', () => {
  it('refuses a bad host or project id with exit 2', () => {
    for (const [host, project] of [
      ['ftp://posthog.example', 1],
      ['not a url', 1],
      ['https://user:pw@posthog.example', 1],
      ['https://posthog.example/?x=1', 1],
      ['https://posthog.example', 'abc'],
    ] as const) {
      expect(() => new PostHogClient({ host, project, key: KEY })).toThrow(
        expect.objectContaining({ exitCode: 2 }),
      );
    }
    expect(
      () => new PostHogClient({ host: 'https://posthog.example', project: 1, key: '' }),
    ).toThrow(expect.objectContaining({ exitCode: 4 }));
    expect(
      new PostHogClient({ host: 'https://eu.posthog.com/', project: '7', key: KEY }).host,
    ).toBe('https://eu.posthog.com');
    expect(new PostHogClient({ host: 'https://ph.example/self/', project: 7, key: KEY }).host).toBe(
      'https://ph.example/self',
    );
  });
});

describe('dropped on arrival', () => {
  it('drops results, alert values, check history and people, and keeps definitions whole', async () => {
    const insight = {
      id: 1,
      name: 'Orders',
      result: [{ count: 5 }],
      hasMore: false,
      columns: ['a'],
      types: ['Int'],
      created_by: { email: 'someone@example.com' },
      last_modified_by: { first_name: 'X' },
      query: {
        kind: 'DataTableNode',
        columns: ['event'],
        source: { kind: 'EventsQuery', select: ['*'] },
      },
      filters: { result: 'kept inside a definition' },
      dashboard_tiles: [{ id: 3, insight: { id: 1, result: [1], created_by: {} } }],
    };
    const alert = {
      id: 'a',
      last_value: 3,
      checks: [{ state: 'Firing' }],
      subscribed_users: [{ email: 'x' }],
      threshold: { configuration: {} },
    };
    expect(dropOnArrival({ results: [insight, alert], next: null })).toEqual({
      results: [
        {
          id: 1,
          name: 'Orders',
          query: insight.query,
          filters: insight.filters,
          dashboard_tiles: [{ id: 3, insight: { id: 1 } }],
        },
        { id: 'a', threshold: { configuration: {} } },
      ],
      next: null,
    });
    server = await startMock({ [`GET ${P}/insights/1/`]: { body: insight } });
    const got = (await client(server.base).c.get('insights/1/')) as Record<string, unknown>;
    expect(Object.keys(got).sort()).toEqual(['dashboard_tiles', 'filters', 'id', 'name', 'query']);
  });
});
