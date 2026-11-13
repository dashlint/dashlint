// Contract tests on the demo project's recorded responses (scripts/record-demo.mjs): the client
// replays them page by page, and the shapes `pull` relies on are still what PostHog sends.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PostHogClient, dropOnArrival } from '../../../../src/adapters/posthog/client.js';

interface Recording {
  recorded: { by: string; host: string; project: number; on: string };
  responses: Record<string, unknown>;
}

const recording = JSON.parse(
  readFileSync(new URL('../../../fixtures/posthog-recorded/demo.json', import.meta.url), 'utf8'),
) as Recording;
const { host, project } = recording.recorded;
const base = `${host}/api/projects/${project}/`;

function replay(): { client: PostHogClient; asked: string[] } {
  const asked: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    expect(init?.method).toBe('GET');
    expect(href.startsWith(base)).toBe(true);
    const rel = href.slice(base.length);
    asked.push(rel);
    if (!(rel in recording.responses))
      return new Response('{"detail":"not recorded"}', { status: 404 });
    return new Response(JSON.stringify(recording.responses[rel]), { status: 200 });
  };
  const client = new PostHogClient({
    host,
    project,
    key: 'phx_replay_only',
    fetch,
    info: () => {},
  });
  return { client, asked };
}

type Row = Record<string, unknown>;

describe('recorded demo responses', () => {
  it('were recorded from the demo project by the recorder', () => {
    expect(recording.recorded.by).toBe('scripts/record-demo.mjs');
    expect(recording.recorded.host).toBe('https://us.posthog.com');
    expect(Object.keys(recording.responses).length).toBeGreaterThan(10);
  });

  it('hold nothing the client drops on arrival, and no key, token or email address', () => {
    expect(dropOnArrival(recording.responses)).toEqual(recording.responses);
    const text = JSON.stringify(recording);
    expect(text).not.toMatch(/\bph[xc]_[A-Za-z0-9]{8,}/);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('replay page by page through the client, every list with its results', async () => {
    const { client, asked } = replay();
    const lists = Object.keys(recording.responses).filter(
      (p) => !/offset=/.test(p) && /\?/.test(p),
    );
    for (const path of lists) {
      const rows = await client.getAll(path);
      expect(Array.isArray(rows)).toBe(true);
    }
    for (const path of Object.keys(recording.responses).filter((p) => !p.includes('?')))
      expect(await client.get(path)).toEqual(recording.responses[path]);
    // Every recorded response was reached by the client's own requests (pages included).
    expect([...new Set(asked)].sort()).toEqual(Object.keys(recording.responses).sort());
  });

  it('list every saved insight with its query (V8), and every dashboard tile names a saved insight', async () => {
    const { client } = replay();
    const insights = (await client.getAll('insights/?saved=true&limit=100')) as Row[];
    expect(insights.length).toBeGreaterThan(20);
    for (const i of insights) {
      expect(i.query, `insight ${String(i.short_id)}`).toBeTypeOf('object');
      expect(i).not.toHaveProperty('result');
    }
    const ids = new Set(insights.map((i) => i.id));
    const dashboards = (await client.getAll('dashboards/?limit=100')) as Row[];
    expect(dashboards.length).toBeGreaterThan(0);
    for (const d of dashboards.filter((x) => !x.deleted)) {
      const full = (await client.get(`dashboards/${String(d.id)}/`)) as {
        tiles: { insight?: Row | null }[];
      };
      for (const t of full.tiles) if (t.insight) expect(ids.has(t.insight.id)).toBe(true);
    }
  });

  it('give alerts their state and threshold, event definitions last_seen_at, properties is_seen_on_filtered_events', async () => {
    const { client } = replay();
    const alerts = (await client.getAll('alerts/?limit=100')) as Row[];
    expect(alerts.length).toBeGreaterThan(0);
    for (const a of alerts) {
      for (const k of ['state', 'enabled', 'condition', 'threshold', 'insight'])
        expect(a).toHaveProperty(k);
      expect(a).not.toHaveProperty('last_value');
      expect(a).not.toHaveProperty('checks');
    }
    const events = (await client.getAll('event_definitions/?limit=100')) as Row[];
    expect(events.length).toBeGreaterThan(5);
    for (const e of events) expect(e).toHaveProperty('last_seen_at');
    const propertyPaths = Object.keys(recording.responses).filter((p) =>
      p.includes('filter_by_event_names=true'),
    );
    expect(propertyPaths.length).toBeGreaterThan(5);
    for (const p of propertyPaths) {
      const rows = (await client.getAll(p)) as Row[];
      for (const r of rows) expect(r).toHaveProperty('is_seen_on_filtered_events');
    }
  });
});
