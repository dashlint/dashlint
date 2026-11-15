#!/usr/bin/env node
// Measures spec 6.12's performance budgets on the synthetic app from gen-perf-app.mjs and compares each
// figure with its budget. Needs a built CLI (`npm run build`). Runs every operation RUNS times and
// compares the median with the budget; the raw runs are printed too.
//
// Rows: extract (1,000 files), peak memory of that extract, check (200 tiles, two catalogs), pull (200
// insights against a local mock that enforces the documented limits: 3 in flight, 240 a minute, plus
// a fixed per-request latency), the Action step (bundle, two extracts, 1,000-file repo), HTML size.
//
// Usage: node scripts/perf.mjs --work <dir> [--runs 3] [--budgets <json>] [--md <file>] [--json <file>]
//          [--ubuntu]       use the ubuntu budgets (extract 45 s) instead of the Mac ones (20 s)
//          [--latency 100]  ms of latency the pull mock adds to every response
// Exit 0 when every row is under its budget, 1 when one is over, 2 on a usage error.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './gen-perf-app.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(CLI, 'dist/cli/main.js');
const ACTION = join(CLI, 'dist/action.mjs');
const RECORDED = join(CLI, 'test/fixtures/posthog-recorded/demo.json');

/** The spec 6.12 budgets, in seconds, megabytes and bytes. */
export const BUDGETS = {
  extractSeconds: 20,
  extractSecondsUbuntu: 45,
  extractMemoryMb: 2048,
  checkSeconds: 1,
  checkEndToEndSeconds: 1,
  pullSeconds: 60,
  actionSeconds: 120,
  htmlBytes: 2 * 1024 * 1024,
};

const args = { work: '', runs: 3, budgets: '', md: '', json: '', ubuntu: false, latency: 100 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--work') args.work = resolve(process.argv[++i] ?? '');
  else if (a === '--runs') args.runs = Number(process.argv[++i]);
  else if (a === '--budgets') args.budgets = resolve(process.argv[++i] ?? '');
  else if (a === '--md') args.md = resolve(process.argv[++i] ?? '');
  else if (a === '--json') args.json = resolve(process.argv[++i] ?? '');
  else if (a === '--ubuntu') args.ubuntu = true;
  else if (a === '--latency') args.latency = Number(process.argv[++i]);
  else usage(`unknown argument ${a}`);
}
if (!args.work) usage('--work <dir> is required');
if (!(args.runs >= 1)) usage('--runs must be at least 1');
if (!existsSync(BIN) || !existsSync(ACTION)) usage('dist/ is missing; run npm run build first');

function usage(msg) {
  process.stderr.write(
    `perf: ${msg}\nusage: node scripts/perf.mjs --work <dir> [--runs 3] [--budgets <json>] [--md <file>] [--json <file>] [--ubuntu] [--latency 100]\n`,
  );
  process.exit(2);
}

const budgets = {
  ...BUDGETS,
  ...(args.budgets ? JSON.parse(readFileSync(args.budgets, 'utf8')) : {}),
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const env = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  NO_COLOR: '1',
  CI: 'true',
};

function run(argv, opts = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    env: { ...env, ...opts.env },
    cwd: opts.cwd,
    maxBuffer: 1 << 28,
  });
  return {
    seconds: Number(process.hrtime.bigint() - t0) / 1e9,
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}
function must(r, what) {
  if (r.status !== 0 && r.status !== 1)
    throw new Error(`${what} exited ${r.status}: ${r.stderr.slice(0, 400)}`);
  return r;
}

/** Peak resident memory of one command in MB, through /usr/bin/time (macOS -l, Linux -v). */
function peakMemoryMb(argv, cwd) {
  const mac = process.platform === 'darwin';
  const r = spawnSync('/usr/bin/time', [mac ? '-l' : '-v', process.execPath, ...argv], {
    encoding: 'utf8',
    env,
    cwd,
    maxBuffer: 1 << 28,
  });
  const m = mac
    ? /(\d+)\s+maximum resident set size/.exec(r.stderr)
    : /Maximum resident set size \(kbytes\): (\d+)/.exec(r.stderr);
  if (!m)
    throw new Error(`could not read peak memory from /usr/bin/time:\n${r.stderr.slice(-400)}`);
  return Number(m[1]) / (mac ? 1024 * 1024 : 1024);
}

// ---- the app
const app = join(args.work, 'app');
generate({ out: app });
const git = (...a) =>
  execFileSync(
    'git',
    ['-C', app, '-c', 'user.name=Shop', '-c', 'user.email=shop@example.invalid', ...a],
    { encoding: 'utf8' },
  ).trim();
writeFileSync(join(app, '.gitignore'), 'node_modules\n');
for (const dir of ['web', 'admin']) {
  const r = spawnSync(
    'npm',
    ['--prefix', join(app, dir), 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
    { encoding: 'utf8', env: { ...env, npm_config_loglevel: 'error' } },
  );
  if (r.status !== 0) throw new Error(`npm install in ${dir} failed: ${r.stderr.slice(0, 400)}`);
}
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'base');
const baseSha = git('rev-parse', 'HEAD');
const touched = join(app, 'web/src/area0/module0.ts');
writeFileSync(
  touched,
  readFileSync(touched, 'utf8').replace("format: 'paperback'", "format: 'hardback'"),
);
git('commit', '-q', '-am', 'head');

const rows = [];
function row(name, unit, budgetKey, values, extra = '', counts = true) {
  const value = median(values);
  const budget = budgets[budgetKey];
  rows.push({ name, unit, value, budget, ok: value <= budget, counts, runs: values, extra });
}

// ---- extract, 1,000 files
const extractSeconds = [];
for (let i = 0; i < args.runs; i++) {
  extractSeconds.push(
    must(
      run([BIN, 'extract', '--cwd', app, '--source', 'web', '--out', join(args.work, 'web.json')]),
      'extract',
    ).seconds,
  );
}
const webCatalog = JSON.parse(readFileSync(join(args.work, 'web.json'), 'utf8'));
const files = webCatalog.coverage.files;
if (files < 1000) throw new Error(`the extract read ${files} files, expected at least 1000`);
row(
  'extract on a 1,000-file app',
  's',
  args.ubuntu ? 'extractSecondsUbuntu' : 'extractSeconds',
  extractSeconds,
  `${files} files, ${Object.keys(webCatalog.events).length} events`,
);
row(
  'extract peak memory',
  'MB',
  'extractMemoryMb',
  [
    peakMemoryMb([
      BIN,
      'extract',
      '--cwd',
      app,
      '--source',
      'web',
      '--out',
      join(args.work, 'web.json'),
    ]),
  ],
  'one run',
);

// ---- check, 200 tiles, two catalogs
must(
  run([BIN, 'extract', '--cwd', app, '--source', 'admin', '--out', join(args.work, 'admin.json')]),
  'extract admin',
);
const checkArgs = [
  'check',
  '--cwd',
  app,
  '--catalog',
  join(args.work, 'web.json'),
  '--catalog',
  join(args.work, 'admin.json'),
  '--requirements',
  join(app, 'dashlint.requirements.json'),
];
const checkSeconds = [];
const checkEndToEnd = [];
const probe = join(CLI, 'scripts/perf-check-probe.mjs');
for (let i = 0; i < args.runs; i++) {
  const out = join(args.work, 'check.json');
  const r = must(run([probe, ...checkArgs, '--format', 'json', '--out', out]), 'check probe');
  const p = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}');
  if (p.code !== 0 && p.code !== 1) throw new Error(`check exited ${p.code} in the probe`);
  checkSeconds.push(p.runSeconds);
  checkEndToEnd.push(
    must(run([BIN, ...checkArgs, '--format', 'json', '--out', out]), 'check').seconds,
  );
}
const tiles = JSON.parse(readFileSync(join(args.work, 'check.json'), 'utf8')).tiles.length;
if (tiles !== 200) throw new Error(`the report has ${tiles} tiles, expected 200`);
row(
  'check on 200 tiles, two catalogs',
  's',
  'checkSeconds',
  checkSeconds,
  `${tiles} tiles; the command in a warm process, without the module import (ADR-067)`,
);
row(
  'check end to end (information)',
  's',
  'checkEndToEndSeconds',
  checkEndToEnd,
  'a fresh process with node and TypeScript start-up; compared with the same 1 s, not part of the verdict',
  false,
);

// ---- HTML report size
const htmlPath = join(args.work, 'report.html');
must(run([BIN, ...checkArgs, '--format', 'html', '--out', htmlPath]), 'check html');
row('HTML report at 200 tiles', 'bytes', 'htmlBytes', [statSync(htmlPath).size], `${tiles} tiles`);

// ---- the Action step, two extracts on the 1,000-file repo
const actionDir = join(args.work, 'action');
rmSync(actionDir, { recursive: true, force: true });
mkdirSync(join(actionDir, 'dist'), { recursive: true });
cpSync(ACTION, join(actionDir, 'dist/action.mjs'));
if (existsSync(join(CLI, 'descriptors')))
  cpSync(join(CLI, 'descriptors'), join(actionDir, 'descriptors'), { recursive: true });
const event = join(args.work, 'event.json');
writeFileSync(
  event,
  JSON.stringify({
    repository: { full_name: 'bookshop/perf' },
    pull_request: {
      number: 1,
      base: { sha: baseSha },
      head: { repo: { full_name: 'bookshop/perf' } },
    },
  }),
);
const actionSeconds = [];
for (let i = 0; i < args.runs; i++) {
  const out = join(args.work, 'action-out.txt');
  writeFileSync(out, '');
  const r = run([join(actionDir, 'dist/action.mjs')], {
    cwd: app,
    env: {
      GITHUB_WORKSPACE: app,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: 'bookshop/perf',
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: join(args.work, 'summary.md'),
      RUNNER_TEMP: args.work,
      INPUT_COMMENT: 'false',
    },
  });
  if (r.status !== 0 && r.status !== 1)
    throw new Error(`the Action bundle exited ${r.status}: ${(r.stdout + r.stderr).slice(-400)}`);
  actionSeconds.push(r.seconds);
}
row(
  'Action step on a 1,000-file repo',
  's',
  'actionSeconds',
  actionSeconds,
  'two extracts, comment off, excludes checkout and install',
);

// ---- pull, 200 insights against a mock that enforces the limits
const recording = JSON.parse(readFileSync(RECORDED, 'utf8'));
const insightsKey = 'insights/?saved=true&limit=100';
const template = recording.responses[insightsKey].results;
const cloned = [];
for (let i = 0; i < 200; i++) {
  const t = JSON.parse(JSON.stringify(template[i % template.length]));
  t.id = 20_000_000 + i;
  t.short_id = `P${String(i).padStart(7, '0')}`;
  cloned.push(t);
}
const pages = [cloned.slice(0, 100), cloned.slice(100, 200)];
const { project } = recording.recorded;
const prefix = `/api/projects/${project}/`;
const started = [];
let inFlight = 0;
let maxInFlight = 0;
let misses = 0;
let overLimit = 0;
const server = createServer((req, res) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  const now = Date.now();
  while (started.length && started[0] <= now - 60_000) started.shift();
  started.push(now);
  if (started.length > 240) overLimit++;
  setTimeout(() => {
    const url = req.url ?? '';
    let body;
    let status = 200;
    const rel = url.startsWith(prefix) ? url.slice(prefix.length) : '';
    const m = /^insights\/\?saved=true&limit=100(?:&offset=(\d+))?$/.exec(rel);
    if (rel === insightsKey)
      body = {
        count: 200,
        next: `http://${req.headers.host}${prefix}insights/?saved=true&limit=100&offset=100`,
        previous: null,
        results: pages[0],
      };
    else if (m && m[1] === '100')
      body = { count: 200, next: null, previous: null, results: pages[1] };
    else if (rel in recording.responses) body = recording.responses[rel];
    else {
      misses++;
      status = 404;
      body = { detail: 'Not found.' };
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    inFlight--;
  }, args.latency);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const pullDir = join(args.work, 'pull');
rmSync(pullDir, { recursive: true, force: true });
mkdirSync(pullDir, { recursive: true });
writeFileSync(
  join(pullDir, 'dashlint.config.yml'),
  `version: 1\nrequirements: out.json\nplatforms:\n  posthog:\n    host: http://127.0.0.1:${port}\n    project: ${project}\n    key: env:PERF_PULL_KEY\n    observedDays: 30\nsources:\n  - name: web\n    path: .\n    platform: web\nfailOn: dead\n`,
);
const pullSeconds = [];
let pulled = 0;
let pullStatus = 0;
for (let i = 0; i < args.runs; i++) {
  started.length = 0;
  // pull is async work against an in-process server, so it must run in a child process.
  const t0 = process.hrtime.bigint();
  const child = spawn(
    process.execPath,
    [BIN, 'pull', '--cwd', pullDir, '--out', join(pullDir, 'out.json')],
    { env: { ...env, PERF_PULL_KEY: 'phx_perf_mock_only' } },
  );
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  pullStatus = await new Promise((r) => child.on('close', r));
  pullSeconds.push(Number(process.hrtime.bigint() - t0) / 1e9);
  if (pullStatus !== 0) throw new Error(`pull exited ${pullStatus}: ${err.slice(-400)}`);
  pulled = JSON.parse(readFileSync(join(pullDir, 'out.json'), 'utf8')).tiles.length;
}
server.close();
if (pulled < 200) throw new Error(`pull wrote ${pulled} tiles, expected 200 or more`);
row(
  'pull on 200 insights',
  's',
  'pullSeconds',
  pullSeconds,
  `${pulled} tiles, ${args.latency} ms mock latency, max ${maxInFlight} in flight, ${overLimit} requests over 240 a minute, ${misses} unrecorded paths`,
);
if (maxInFlight > 3 || overLimit > 0)
  throw new Error(
    `pull broke the documented limits: ${maxInFlight} in flight, ${overLimit} over 240 a minute`,
  );

// ---- report
const fmt = (r, v) =>
  r.unit === 'bytes'
    ? `${(v / 1024).toFixed(0)} KB`
    : r.unit === 'MB'
      ? `${v.toFixed(0)} MB`
      : `${v.toFixed(2)} s`;
const lines = [
  '| Operation | Measured (median) | Budget | Result | Runs | Notes |',
  '|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.name} | ${fmt(r, r.value)} | ${fmt(r, r.budget)} | ${r.ok ? 'under' : r.counts ? 'OVER' : 'info: over'} | ${r.runs.map((v) => fmt(r, v)).join(', ')} | ${r.extra} |`,
  ),
];
const machine = `${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model ?? 'unknown cpu'} x ${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB, node ${process.version}`;
process.stdout.write(`${lines.join('\n')}\n\nmachine: ${machine}\n`);
if (args.md) writeFileSync(args.md, `${lines.join('\n')}\n\nMachine: ${machine}\n`);
if (args.json)
  writeFileSync(args.json, `${JSON.stringify({ machine, runs: args.runs, rows }, null, 2)}\n`);
const over = rows.filter((r) => r.counts && !r.ok);
if (over.length) process.stderr.write(`perf: over budget: ${over.map((r) => r.name).join('; ')}\n`);
process.exit(over.length ? 1 : 0);
