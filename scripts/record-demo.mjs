#!/usr/bin/env node
// Records the demo PostHog project's definition responses for the adapter's contract tests (spec
// 6.16, T5.1), through the real client (dist/adapters/posthog/client.js), so the recording is what
// `pull` itself receives: GET only, results and people dropped on arrival.
//
// Usage (the maintainer's demo read key, never a literal; build first):
//   node <notes>/runner/with-key.mjs dashlint-posthog-demo-read -- node scripts/record-demo.mjs [--out <file>]
// Default output: test/fixtures/posthog-recorded/demo.json. Review the diff before committing it.
//
// Only the demo project (a fictional bookshop, public at release) is ever recorded. The file is
// written only when it holds no key, no project token and no email address.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const DEMO_PROJECT = 731105;
const HOST = 'https://us.posthog.com';
const ENV = 'DASHLINT_POSTHOG_KEY';

/** Event names a query or action step references (EventsNode `event`), and ActionsNode ids. */
export function referenced(insights) {
  const events = new Set();
  const actions = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    if (o.kind === 'EventsNode' && typeof o.event === 'string') events.add(o.event);
    if (o.kind === 'ActionsNode' && (typeof o.id === 'number' || typeof o.id === 'string'))
      actions.add(String(o.id));
    Object.values(o).forEach(walk);
  };
  for (const i of insights) walk(i.query);
  return { events, actions };
}

/** What must never be in a recording: the key, PostHog key or token prefixes, email addresses. */
export function leaks(text, key) {
  const found = [];
  if (key && text.includes(key)) found.push('the key');
  for (const m of text.matchAll(/\bph[xc]_[A-Za-z0-9]{8,}/g))
    found.push(`a PostHog key or token (${m[0].slice(0, 4)}...)`);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g))
    found.push(`an email address (...@${m[0].split('@')[1]})`);
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = resolve(
    i >= 0 ? args[i + 1] : resolve(ROOT, 'test/fixtures/posthog-recorded/demo.json'),
  );
  const key = process.env[ENV];
  if (!key) {
    console.error(
      `record-demo: ${ENV} is not set; run it through the runner's with-key.mjs with the demo read key`,
    );
    return 2;
  }
  const { PostHogClient, PullError } = await import(
    pathToFileURL(resolve(ROOT, 'dist/adapters/posthog/client.js')).href
  );
  const client = new PostHogClient({
    host: HOST,
    project: DEMO_PROJECT,
    key,
    info: (l) => console.error(l),
  });
  const responses = {};
  const record = async (path) => {
    responses[path] = await client.get(path);
    return responses[path];
  };
  const recordAll = async (path) => {
    const rows = [];
    for await (const page of client.pages(path)) {
      responses[page.path] = page.body;
      rows.push(...(page.body.results ?? []));
    }
    return rows;
  };
  try {
    const insights = await recordAll('insights/?saved=true');
    const dashboards = await recordAll('dashboards/');
    for (const d of dashboards.filter((x) => !x.deleted)) await record(`dashboards/${d.id}/`);
    await recordAll('alerts/');
    const { events, actions } = referenced(insights);
    for (const id of [...actions].sort()) {
      const action = await record(`actions/${id}/`);
      for (const s of action.steps ?? []) if (typeof s.event === 'string') events.add(s.event);
    }
    await recordAll('event_definitions/');
    for (const ev of [...events].sort())
      await recordAll(
        `property_definitions/?type=event&event_names=${encodeURIComponent(JSON.stringify([ev]))}&filter_by_event_names=true`,
      );
    await recordAll('property_definitions/?type=person');

    const doc = {
      recorded: {
        by: 'scripts/record-demo.mjs',
        host: HOST,
        project: DEMO_PROJECT,
        on: new Date().toISOString().slice(0, 10),
      },
      responses,
    };
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    const found = leaks(text, key);
    if (found.length > 0) {
      console.error(
        `record-demo: not written, the recording holds ${[...new Set(found)].join(', ')}`,
      );
      return 1;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(
      `record-demo: ${Object.keys(responses).length} responses (${insights.length} insights, ${dashboards.length} dashboards, ${actions.size} actions, ${events.size} referenced events) in ${client.requests} requests, written ${out}`,
    );
    return 0;
  } catch (e) {
    if (e instanceof PullError) {
      console.error(`record-demo: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
