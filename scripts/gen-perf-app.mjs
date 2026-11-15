#!/usr/bin/env node
// Generates the synthetic app the performance budgets are measured on (spec 6.12): a bookshop web
// app of N TypeScript files that send PostHog events, a small second source, a dashlint.config.yml
// and a requirements snapshot of T tiles. Everything is invented and deterministic (no randomness),
// so two runs write the same bytes.
//
// Usage: node scripts/gen-perf-app.mjs --out <dir> [--files 1000] [--tiles 200] [--admin-files 40]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const EVENT_COUNT = 200;
const GENRES = ['fiction', 'poetry', 'travel', 'cooking', 'history'];
const NOUNS = [
  'shelf',
  'basket',
  'author',
  'series',
  'voucher',
  'review',
  'reading',
  'order',
  'invoice',
  'cover',
];
const VERBS = [
  'viewed',
  'opened',
  'added',
  'removed',
  'shared',
  'saved',
  'sorted',
  'filtered',
  'paid',
  'returned',
];

/** The nth event name: `shelf_viewed_000` style, 200 distinct names. */
export function eventName(n) {
  const i = ((n % EVENT_COUNT) + EVENT_COUNT) % EVENT_COUNT;
  return `${NOUNS[i % NOUNS.length]}_${VERBS[Math.floor(i / NOUNS.length) % VERBS.length]}_${String(i).padStart(3, '0')}`;
}

function sourceFile(index, prefix) {
  const a = eventName(index);
  const b = eventName(index * 7 + 3);
  const c = eventName(index * 13 + 5);
  const genre = GENRES[index % GENRES.length];
  return [
    `import posthog from 'posthog-js';`,
    ``,
    `type Genre = 'fiction' | 'poetry' | 'travel' | 'cooking' | 'history';`,
    ``,
    `export interface ${prefix}Row${index} {`,
    `  id: string;`,
    `  title: string;`,
    `  genre: Genre;`,
    `  priceCents: number;`,
    `}`,
    ``,
    `const rows${index}: ${prefix}Row${index}[] = [`,
    `  { id: 'r${index}a', title: 'First ${index}', genre: '${genre}', priceCents: ${1000 + (index % 90)} },`,
    `  { id: 'r${index}b', title: 'Second ${index}', genre: 'fiction', priceCents: ${1500 + (index % 70)} },`,
    `];`,
    ``,
    `export function total${prefix}${index}(list: ${prefix}Row${index}[] = rows${index}): number {`,
    `  return list.reduce((sum, row) => sum + row.priceCents, 0);`,
    `}`,
    ``,
    `export function view${prefix}${index}(id: string, genre: Genre): void {`,
    `  posthog.capture('${a}', { genre_id: genre, format: 'paperback', item_id: id });`,
    `}`,
    ``,
    `export function save${prefix}${index}(row: ${prefix}Row${index}): void {`,
    `  const price = total${prefix}${index}([row]);`,
    `  posthog.capture('${b}', { price_cents: price, genre_id: row.genre });`,
    `  if (price > 2000) {`,
    `    posthog.capture('${c}', { price_cents: price });`,
    `  }`,
    `}`,
    ``,
  ].join('\n');
}

function tile(i) {
  const event = eventName(i);
  const breakdown = i % 4 === 0 ? [{ key: 'genre_id', scope: 'event' }] : [];
  return {
    id: `insight:perf${String(i).padStart(4, '0')}`,
    title: `Bookshop tile ${i}`,
    url: `https://us.posthog.com/project/1/insights/perf${String(i).padStart(4, '0')}`,
    dashboards: [`dashboard:${1 + (i % 5)}`],
    kind: 'trends',
    dateRange: { from: '-30d', to: null },
    testAccountFilter: false,
    series: [{ ref: 'A', node: 'event', event, math: 'total', filters: [] }],
    formulas: [],
    filters: [],
    breakdown,
    notChecked: [],
  };
}

export function generate({ out, files = 1000, tiles = 200, adminFiles = 40 }) {
  rmSync(out, { recursive: true, force: true });
  const put = (rel, text) => {
    const p = join(out, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  const tsconfig = JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
      },
      include: ['src'],
    },
    null,
    2,
  );
  const pkg = (name) =>
    JSON.stringify(
      {
        name,
        private: true,
        version: '0.0.0',
        type: 'module',
        dependencies: { 'posthog-js': '1.447.15' },
      },
      null,
      2,
    );
  put('web/package.json', pkg('perf-web'));
  put('admin/package.json', pkg('perf-admin'));
  put('web/tsconfig.json', tsconfig);
  put('admin/tsconfig.json', tsconfig);
  for (let i = 0; i < files; i++) put(`web/src/area${i % 25}/module${i}.ts`, sourceFile(i, 'Web'));
  for (let i = 0; i < adminFiles; i++) put(`admin/src/screen${i}.ts`, sourceFile(i + 17, 'Admin'));
  put(
    'dashlint.config.yml',
    'version: 1\nrequirements: dashlint.requirements.json\nsources:\n  - name: web\n    path: web\n    platform: web\n  - name: admin\n    path: admin\n    platform: web\nfailOn: dead\n',
  );
  const list = [];
  for (let i = 0; i < tiles; i++) list.push(tile(i));
  put(
    'dashlint.requirements.json',
    `${JSON.stringify(
      {
        schema: 'dashlint.requirements/1',
        source: {
          platform: 'posthog',
          host: 'https://us.posthog.com',
          project: 1,
          pulledAt: '2026-11-15T00:00:00Z',
          tool: '0.0.0',
          profile: 'posthog',
        },
        dashboards: [1, 2, 3, 4, 5].map((n) => ({
          id: `dashboard:${n}`,
          name: `Bookshop board ${n}`,
          filters: [],
        })),
        tiles: list,
      },
      null,
      2,
    )}\n`,
  );
  return { files, tiles, adminFiles };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = { files: 1000, tiles: 200, adminFiles: 40, out: '' };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--out') args.out = process.argv[++i];
    else if (a === '--files') args.files = Number(process.argv[++i]);
    else if (a === '--tiles') args.tiles = Number(process.argv[++i]);
    else if (a === '--admin-files') args.adminFiles = Number(process.argv[++i]);
  }
  if (!args.out) {
    process.stderr.write(
      'usage: node scripts/gen-perf-app.mjs --out <dir> [--files N] [--tiles N] [--admin-files N]\n',
    );
    process.exit(2);
  }
  const r = generate(args);
  process.stdout.write(
    `wrote ${r.files} web files, ${r.adminFiles} admin files and ${r.tiles} tiles to ${args.out}\n`,
  );
}
