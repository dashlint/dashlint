// `pull` (T5.5): reads a project through the client, writes canonical requirements; the same
// project twice gives the same bytes apart from `pulledAt`; `redact: true` leaves no title or name.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PullError } from '../../../../src/adapters/posthog/client.js';
import {
  pullRequirements,
  pullTime,
  redactRequirements,
  requirementsJson,
  type PullOptions,
} from '../../../../src/adapters/posthog/pull.js';
import type { Requirements } from '../../../../src/formats/requirements.js';
import { validateRequirements } from '../../../../src/formats/validate.js';

type Raw = Record<string, unknown>;
type Responses = Record<string, unknown>;

const recording = JSON.parse(
  readFileSync(new URL('../../../fixtures/posthog-recorded/demo.json', import.meta.url), 'utf8'),
) as { recorded: { host: string; project: number }; responses: Responses };
const { host, project } = recording.recorded;
const base = `${host}/api/projects/${project}/`;

const T1 = Date.parse('2026-11-13T10:00:00.250Z');
const T2 = Date.parse('2026-11-13T10:05:41Z');

interface Replay {
  fetch: NonNullable<PullOptions['fetch']>;
  asked: string[];
  methods: string[];
}

/**
 * A fetch over recorded responses. `strict`: an unrecorded path is a 404 (the demo recording holds
 * everything `pull` asks for); otherwise an unrecorded list is empty. `limit` is ignored when the
 * recording has no `limit` in its paths (the twin fixtures).
 */
function replay(
  responses: Responses,
  opts: { strict?: boolean; reverseLists?: boolean; missing?: RegExp } = {},
): Replay {
  const asked: string[] = [];
  const methods: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    expect(href.startsWith(base)).toBe(true);
    methods.push(String(init?.method));
    const rel = href.slice(base.length);
    asked.push(rel);
    const key =
      rel in responses ? rel : rel.replace(/[?&]limit=100$/, '').replace(/[?&]limit=100&/, '?');
    let body = responses[key];
    if (opts.missing?.test(rel)) body = undefined;
    if (body === undefined) {
      if (!opts.strict && !opts.missing?.test(rel) && /\?|\/$/.test(rel) && !/\/\d+\/$/.test(rel))
        return new Response(JSON.stringify({ next: null, results: [] }), { status: 200 });
      return new Response('{"detail":"Not found."}', { status: 404 });
    }
    if (opts.reverseLists && body && typeof body === 'object' && 'results' in body)
      body = { ...body, results: [...((body as { results: unknown[] }).results ?? [])].reverse() };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch, asked, methods };
}

function options(r: Replay, extra: Partial<PullOptions> = {}): PullOptions {
  return {
    host,
    project,
    key: 'phx_replay_only',
    tool: '0.0.0-test',
    fetch: r.fetch,
    info: () => {},
    now: () => T1,
    ...extra,
  };
}

async function pullText(r: Replay, extra: Partial<PullOptions> = {}): Promise<string> {
  return requirementsJson(await pullRequirements(options(r, extra)));
}

describe('pull on the recorded demo project', () => {
  it('reads only recorded definitions, GET only, and writes requirements that validate', async () => {
    const r = replay(recording.responses, { strict: true });
    const text = await pullText(r);
    expect(new Set(r.methods)).toEqual(new Set(['GET']));
    for (const p of r.asked) expect(Object.keys(recording.responses)).toContain(p);
    const parsed = JSON.parse(text) as Requirements;
    expect(validateRequirements(parsed).ok).toBe(true);
    expect(parsed.source).toEqual({
      platform: 'posthog',
      host,
      project,
      pulledAt: '2026-11-13T10:00:00Z',
      tool: '0.0.0-test',
      profile: 'posthog',
    });
    expect(parsed.tiles.length).toBeGreaterThan(20);
    expect(parsed.dashboards?.length).toBe(3);
    expect(parsed.alerts?.length).toBe(5);
    expect(Object.keys(parsed.observed?.events ?? {}).length).toBeGreaterThan(5);
    expect(parsed.observed?.windowDays).toBe(30);
    for (const t of parsed.tiles)
      for (const n of t.notChecked ?? []) expect(n.reason).not.toMatch(/was not read/);
  });

  it('two pulls are byte-identical apart from pulledAt, also when PostHog lists rows in another order', async () => {
    const a = await pullText(replay(recording.responses, { strict: true }));
    const again = await pullText(replay(recording.responses, { strict: true }));
    expect(again).toBe(a);
    const b = await pullText(replay(recording.responses, { strict: true, reverseLists: true }), {
      now: () => T2,
    });
    expect(b).not.toBe(a);
    const lines = (s: string) => s.split('\n');
    const differing = lines(a).filter((l, i) => l !== lines(b)[i]);
    expect(differing).toEqual(['    "pulledAt": "2026-11-13T10:00:00Z",']);
    expect(b.replace('2026-11-13T10:05:41Z', '2026-11-13T10:00:00Z')).toBe(a);
    expect(a.endsWith('}\n')).toBe(true);
  });

  it('observedDays sets the window', async () => {
    const text = await pullText(replay(recording.responses, { strict: true }), {
      observedDays: 7,
    });
    expect((JSON.parse(text) as Requirements).observed?.windowDays).toBe(7);
  });

  it('with redact: true every title is its id and no dashboard, alert or action keeps a name', async () => {
    const text = await pullText(replay(recording.responses, { strict: true }), { redact: true });
    const parsed = JSON.parse(text) as Requirements;
    expect(validateRequirements(parsed).ok).toBe(true);
    for (const t of parsed.tiles) expect(t.title).toBe(t.id);
    const names: string[] = [];
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object')
        for (const [k, v] of Object.entries(o)) {
          if (k === 'name' || k === 'title') names.push(String(v));
          walk(v);
        }
    };
    walk(parsed);
    expect(names.sort()).toEqual(parsed.tiles.map((t) => t.id).sort());
    // Every insight, dashboard, alert and action name PostHog sent is absent from the file. An
    // EventsNode carries the event name as its `name`; event names stay, so they are not counted.
    const sent = new Set<string>();
    const events = new Set<string>();
    const collect = (o: unknown, inName = false): void => {
      if (Array.isArray(o)) o.forEach((x) => collect(x));
      else if (o && typeof o === 'object') {
        const event = (o as Raw).event;
        if (typeof event === 'string') events.add(event);
        for (const [k, v] of Object.entries(o)) collect(v, k === 'name' || k === 'derived_name');
      } else if (inName && typeof o === 'string' && o !== '') sent.add(o);
    };
    for (const [path, body] of Object.entries(recording.responses))
      if (/^(insights|dashboards|alerts|actions)\//.test(path)) collect(body);
    for (const e of events) sent.delete(e);
    expect(sent.size).toBeGreaterThan(10);
    const unredacted = await pullText(replay(recording.responses, { strict: true }));
    let shown = 0;
    for (const name of sent) {
      expect(text, name).not.toContain(JSON.stringify(name));
      if (unredacted.includes(JSON.stringify(name))) shown++;
    }
    // The positive control: without redact the same names are in the file.
    expect(shown).toBeGreaterThan(10);
  });
});

// ---------- the twin fixtures merged into one project ----------

function twin(name: string): Responses {
  return (
    JSON.parse(
      readFileSync(new URL(`../../../fixtures/posthog/${name}.json`, import.meta.url), 'utf8'),
    ) as { responses: Responses }
  ).responses;
}

function merged(): Responses {
  const parts = ['alerts', 'dashboards', 'funnel-action-steps'].map(twin);
  const out: Responses = {};
  for (const part of parts)
    for (const [path, body] of Object.entries(part)) {
      const prev = out[path] as { results?: unknown[] } | undefined;
      const rows = (body as { results?: unknown[] }).results;
      out[path] = prev?.results && rows ? { ...prev, results: [...prev.results, ...rows] } : body;
    }
  return out;
}

describe('pull on the twin fixtures', () => {
  const responses = merged();

  it('reads dashboards, alerts and actions and leaves no user-written name with redact', async () => {
    const plain = await pullText(replay(responses));
    const redacted = await pullText(replay(responses), { redact: true });
    const names = [
      'Bookshop growth',
      'Gift card redemptions dropped',
      'Gift card redemptions',
      'Cart to order via checkout',
      'Checkout started (web or app)',
    ];
    for (const n of names) {
      expect(plain, n).toContain(JSON.stringify(n));
      expect(redacted, n).not.toContain(JSON.stringify(n));
    }
    const r = JSON.parse(redacted) as Requirements;
    expect(r.dashboards?.length).toBeGreaterThan(0);
    for (const d of r.dashboards ?? []) expect(d).not.toHaveProperty('name');
    for (const a of r.alerts ?? []) expect(a).not.toHaveProperty('name');
  });

  it('fetches each action once, and an action PostHog no longer has leaves its nodes not checked', async () => {
    const ok = replay(responses);
    await pullText(ok);
    expect(ok.asked.filter((p) => p.startsWith('actions/'))).toEqual(['actions/77/']);
    const lines: string[] = [];
    const gone = replay(responses, { missing: /^actions\// });
    const r = await pullRequirements(options(gone, { info: (l) => lines.push(l) }));
    expect(lines).toContain('pull: action 77 was not found; its tiles are not checked');
    const reasons = r.tiles.flatMap((t) => (t.notChecked ?? []).map((n) => n.reason));
    expect(reasons).toContain('action 77 was not read');
    expect(validateRequirements(r).ok).toBe(true);
  });

  it('stops on any other failure with the client exit code', async () => {
    const r = replay(responses, { missing: /^alerts\// });
    const err = await pullRequirements(options(r)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullError);
    expect((err as PullError).exitCode).toBe(4);
    expect((err as PullError).status).toBe(404);
  });

  it('skips deleted dashboards and asks person properties only when a tile references one', async () => {
    const withDeleted = merged();
    const list = withDeleted['dashboards/'] as { results: Raw[] };
    withDeleted['dashboards/'] = {
      ...list,
      results: [...list.results, { id: 999, name: 'Gone', deleted: true }],
    };
    const r = replay(withDeleted);
    await pullText(r);
    expect(r.asked.some((p) => p.startsWith('dashboards/999/'))).toBe(false);
    expect(r.asked.some((p) => p.includes('type=person'))).toBe(false);
  });
});

describe('pull helpers', () => {
  it('pullTime writes UTC whole seconds', () => {
    expect(pullTime(Date.parse('2026-12-18T09:12:00.999Z'))).toBe('2026-12-18T09:12:00Z');
  });

  it('redactRequirements keeps everything but names; requirements without lists stay valid', () => {
    const r: Requirements = {
      schema: 'dashlint.requirements/1',
      source: { platform: 'posthog' },
      tiles: [
        {
          id: 'insight:Ab12Cd34',
          title: 'Wishlist shares, fiction',
          kind: 'retention',
          retention: {
            target: { node: 'action', action: { id: 7, name: 'Purchased', steps: [] } },
            returning: { node: 'all-events' },
          },
          exclusions: [{ node: 'action', action: { id: 8, name: 'Refunded', steps: [] } }],
        },
      ],
    };
    const out = redactRequirements(r);
    expect(out.tiles[0]?.title).toBe('insight:Ab12Cd34');
    expect(JSON.stringify(out)).not.toMatch(/Purchased|Refunded|fiction/);
    expect(out).not.toHaveProperty('dashboards');
    expect(out).not.toHaveProperty('alerts');
    expect(r.tiles[0]?.title).toBe('Wishlist shares, fiction');
  });

  it('requirementsJson refuses requirements that do not validate (exit 3)', () => {
    const bad = { schema: 'dashlint.requirements/1', source: {}, tiles: [] } as unknown;
    const err = (() => {
      try {
        requirementsJson(bad as Requirements);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PullError);
    expect((err as PullError).exitCode).toBe(3);
  });
});
