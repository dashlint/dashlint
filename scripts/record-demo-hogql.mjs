#!/usr/bin/env node
// Records the demo PostHog project's answers to `pull`'s HogQL recency queries (spec 6.5.1, T5.6)
// for the adapter's tests. The definitions come from the existing recording
// (test/fixtures/posthog-recorded/demo.json), so the queries are exactly the ones `pull` asks for
// those definitions; only the POSTs to `query/` reach PostHog, through the real `pull`
// (dist/adapters/posthog/pull.js) with `hogql: true`.
//
// Usage (the maintainer's demo read key with query:read, never a literal; build first):
//   node <notes>/runner/with-key.mjs dashlint-posthog-demo-read -- node scripts/record-demo-hogql.mjs [--out <file>]
// Default output: test/fixtures/posthog-recorded/demo-hogql.json. Review the diff before committing.
//
// Each answer keeps only `results` (one row of timestamps), `columns` and `error`, and the cost
// headers PostHog sent. The file is written only when it holds no key, token or email address.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { leaks } from './record-demo.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ENV = 'DASHLINT_POSTHOG_KEY';
const KEPT = ['results', 'columns', 'error'];
const COST_HEADERS = ['x-posthog-query-bytes-read'];

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = resolve(
    i >= 0 ? args[i + 1] : resolve(ROOT, 'test/fixtures/posthog-recorded/demo-hogql.json'),
  );
  const key = process.env[ENV];
  if (!key) {
    console.error(
      `record-demo-hogql: ${ENV} is not set; run it through the runner's with-key.mjs with the demo read key`,
    );
    return 2;
  }
  const definitions = JSON.parse(
    readFileSync(resolve(ROOT, 'test/fixtures/posthog-recorded/demo.json'), 'utf8'),
  );
  const { host, project } = definitions.recorded;
  const base = `${host}/api/projects/${project}/`;
  const { pullRequirements } = await import(
    pathToFileURL(resolve(ROOT, 'dist/adapters/posthog/pull.js')).href
  );
  const { PullError } = await import(
    pathToFileURL(resolve(ROOT, 'dist/adapters/posthog/client.js')).href
  );
  const queries = [];
  let ms = 0;
  const fetch = async (url, init) => {
    const href = String(url);
    if (!href.startsWith(base)) throw new Error(`record-demo-hogql: unexpected URL ${href}`);
    const rel = href.slice(base.length);
    if (init?.method === 'GET') {
      const key2 = rel in definitions.responses ? rel : rel.replace(/[?&]limit=100$/, '');
      const body = definitions.responses[key2];
      return body === undefined
        ? new Response('{"detail":"Not found."}', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }
    if (init?.method !== 'POST' || rel !== 'query/')
      throw new Error(`record-demo-hogql: unexpected ${init?.method} ${rel}`);
    const t0 = Date.now();
    const res = await globalThis.fetch(url, init);
    ms += Date.now() - t0;
    const text = await res.text();
    const parsed = JSON.parse(text);
    const answer = Object.fromEntries(KEPT.filter((k) => k in parsed).map((k) => [k, parsed[k]]));
    const headers = Object.fromEntries(
      COST_HEADERS.filter((h) => res.headers.has(h)).map((h) => [h, res.headers.get(h)]),
    );
    queries.push({ request: JSON.parse(init.body), status: res.status, headers, answer });
    return new Response(JSON.stringify(answer), { status: res.status });
  };
  try {
    const requirements = await pullRequirements({
      host,
      project,
      key,
      hogql: true,
      tool: 'record-demo-hogql',
      fetch,
      info: (l) => console.error(l),
    });
    const doc = {
      recorded: {
        by: 'scripts/record-demo-hogql.mjs',
        host,
        project,
        on: new Date().toISOString().slice(0, 10),
        definitionsOn: definitions.recorded.on,
        windowDays: requirements.observed?.windowDays,
      },
      queries,
    };
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    const found = leaks(text, key);
    if (found.length > 0) {
      console.error(
        `record-demo-hogql: not written, the recording holds ${[...new Set(found)].join(', ')}`,
      );
      return 1;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(
      `record-demo-hogql: ${queries.length} queries in ${ms} ms, statuses ${[...new Set(queries.map((q) => q.status))].join(',')}, written ${out}`,
    );
    return 0;
  } catch (e) {
    if (e instanceof PullError) {
      console.error(`record-demo-hogql: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
