// Opt-in HogQL property recency (spec 6.5.1, T2, T5.6; `platforms.posthog.hogql: true`). Property
// definitions only say whether PostHog ever saw a property on an event; with the opt-in, `pull` asks
// `query/` when each referenced (event, property) last arrived inside the `observedDays` window, one
// aggregate query per event:
//
//   SELECT maxIf(timestamp, JSONHas(properties, {p0})), ... FROM events
//   WHERE event = {e} AND timestamp >= now() - INTERVAL 30 DAY
//
// Names travel as HogQL placeholders (`values`), never spliced into the text. The answer is one row of
// timestamps: a match inside the window is seen, and ClickHouse's empty maximum (1970-01-01, or
// null) is not seen. The result replaces that pair's "ever seen" fact in `observed.eventProperties`,
// so seen and notSeen then mean "inside the window", as events' `lastSeenAt` already does
// (ADR-036). Every query passes `assertAggregateOnly` before it is sent: rows are never asked for.
import type { Observed, Requirements, SeenProperties } from '../../formats/requirements.js';
import { pullMessages } from '../../report/messages.js';
import { PullError, type PostHogClient } from './client.js';
import { DEFAULT_OBSERVED_DAYS, referencesOf } from './normalize/observed.js';
import { isRecord } from './normalize/common.js';

/** Properties asked in one query; an event with more is asked in several. */
export const KEYS_PER_QUERY = 50;

export interface RecencyQuery {
  kind: 'HogQLQuery';
  query: string;
  values: Record<string, string>;
}

/** The one query shape `pull` may send: a single row of per-property maximum timestamps. */
const AGGREGATE_ONLY =
  /^SELECT maxIf\(timestamp, JSONHas\(properties, \{p0\}\)\)(?:, maxIf\(timestamp, JSONHas\(properties, \{p[1-9]\d*\}\)\))* FROM events WHERE event = \{e\} AND timestamp >= now\(\) - INTERVAL [1-9]\d* DAY$/;

/** The query for one event's properties (at most KEYS_PER_QUERY of them). */
export function recencyQuery(
  event: string,
  keys: readonly string[],
  windowDays: number,
): RecencyQuery {
  if (!Number.isInteger(windowDays) || windowDays < 1)
    throw new RangeError(`observedDays must be a whole number of days, at least 1 (${windowDays})`);
  if (keys.length === 0 || keys.length > KEYS_PER_QUERY)
    throw new RangeError(
      `a recency query asks 1 to ${KEYS_PER_QUERY} properties, not ${keys.length}`,
    );
  const columns = keys.map((_, i) => `maxIf(timestamp, JSONHas(properties, {p${i}}))`);
  return {
    kind: 'HogQLQuery',
    query: `SELECT ${columns.join(', ')} FROM events WHERE event = {e} AND timestamp >= now() - INTERVAL ${windowDays} DAY`,
    values: Object.fromEntries([['e', event], ...keys.map((k, i) => [`p${i}`, k])]),
  };
}

/**
 * Refuses (exit 3, a bug in dashlint) anything but the aggregate shape above, with exactly the
 * placeholders it uses, each a string. Called on every query right before it is sent.
 */
export function assertAggregateOnly(q: unknown): asserts q is RecencyQuery {
  const refuse = (why: string): never => {
    throw new PullError(pullMessages.hogqlRefused(why), 3);
  };
  if (!isRecord(q) || q.kind !== 'HogQLQuery') return refuse('not a HogQLQuery');
  const extra = Object.keys(q).filter((k) => !['kind', 'query', 'values'].includes(k));
  if (extra.length > 0) return refuse(`unexpected field ${extra[0]}`);
  if (typeof q.query !== 'string' || !AGGREGATE_ONLY.test(q.query))
    return refuse('only per-property max(timestamp) aggregates are sent, never rows');
  const values = q.values;
  if (!isRecord(values)) return refuse('names must travel as placeholders');
  const columns = q.query.match(/\{p\d+\}/g) ?? [];
  const expected = ['e', ...columns.map((_, i) => `p${i}`)];
  if (columns.some((c, i) => c !== `{p${i}}`)) return refuse('placeholders out of order');
  if (
    Object.keys(values).length !== expected.length ||
    !expected.every((n) => Object.hasOwn(values, n) && typeof values[n] === 'string')
  )
    return refuse('placeholders and values differ');
}

const EPOCH_YEAR = /^1970-01-01T00:00:00(?:\.0+)?Z?$/;

/**
 * One answer: per key, true (arrived inside the window), false (did not), or undefined (the value
 * says nothing; the definitions' fact stays). Anything but one row of `keys.length` cells stops the
 * pull (exit 4); no other cell is ever read.
 */
export function parseRecency(body: unknown, keys: readonly string[]): (boolean | undefined)[] {
  const bad = (why: string): never => {
    throw new PullError(pullMessages.hogqlUnexpected(why), 4);
  };
  if (!isRecord(body)) return bad('not an object');
  if (typeof body.error === 'string' && body.error !== '') return bad(body.error);
  const rows = body.results;
  if (!Array.isArray(rows) || rows.length !== 1) return bad('not exactly one row');
  const row: unknown = rows[0];
  if (!Array.isArray(row) || row.length !== keys.length)
    return bad(`not ${keys.length} column${keys.length === 1 ? '' : 's'}`);
  return row.map((cell: unknown) => {
    if (cell === null) return false;
    if (typeof cell !== 'string') return undefined;
    if (EPOCH_YEAR.test(cell)) return false;
    return Number.isNaN(Date.parse(cell)) ? undefined : true;
  });
}

/** The only way a recency query is sent: it passes `assertAggregateOnly` or never leaves. */
export async function askRecency(client: PostHogClient, q: unknown): Promise<unknown> {
  assertAggregateOnly(q);
  return client.query({ query: q });
}

/** Per event, per property: arrived inside the window or not; a property with no answer is absent. */
export type Recency = Map<string, Map<string, boolean>>;

/** Asks the recency of every referenced (event, event property); requests go one event at a time. */
export async function propertyRecency(
  client: PostHogClient,
  requirements: Pick<Requirements, 'tiles' | 'dashboards'>,
  windowDays: number = DEFAULT_OBSERVED_DAYS,
): Promise<Recency> {
  const out: Recency = new Map();
  for (const [event, keys] of referencesOf(requirements).eventProperties) {
    const facts = new Map<string, boolean>();
    for (let i = 0; i < keys.length; i += KEYS_PER_QUERY) {
      const chunk = keys.slice(i, i + KEYS_PER_QUERY);
      const answer = parseRecency(
        await askRecency(client, recencyQuery(event, chunk, windowDays)),
        chunk,
      );
      chunk.forEach((k, j) => {
        const fact = answer[j];
        if (fact !== undefined) facts.set(k, fact);
      });
    }
    if (facts.size > 0) out.set(event, facts);
  }
  return out;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `observed` with each answered pair's fact replaced by its recency; pairs with no answer keep what
 * the property definitions said, and an event the definitions did not cover gets an entry.
 */
export function applyRecency(observed: Observed, recency: Recency): Observed {
  if (recency.size === 0) return observed;
  const merged = new Map<string, SeenProperties>(Object.entries(observed.eventProperties ?? {}));
  for (const [event, facts] of recency) {
    const before = merged.get(event);
    const state = new Map<string, boolean>();
    for (const k of before?.seen ?? []) state.set(k, true);
    for (const k of before?.notSeen ?? []) state.set(k, false);
    for (const [k, v] of facts) state.set(k, v);
    const keys = [...state.keys()].sort(byCodePoint);
    merged.set(event, {
      seen: keys.filter((k) => state.get(k) === true),
      notSeen: keys.filter((k) => state.get(k) === false),
    });
  }
  // Built with fromEntries so an event named `__proto__` stays an own key, in code-point order.
  const eventProperties = Object.fromEntries([...merged].sort(([a], [b]) => byCodePoint(a, b)));
  return { ...observed, eventProperties };
}
