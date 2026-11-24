// `audit` and `diff` end to end (T7.6): the built binary on a bookshop git repo, run under a preload
// hook that fails on any socket, DNS lookup or fetch (G4). The hook's own test proves it bites.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../../src/cli/main.js';
import { validateReport } from '../../../src/formats/validate.js';
import { CLOSING_SENTENCE, commentText } from '../../../src/report/messages.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const BIN = join(ROOT, 'dist/cli/main.js');
// --import takes a URL: a drive letter reads as a scheme on Windows.
const HOOK = pathToFileURL(join(ROOT, 'test/fixtures/cli/no-network.mjs')).href;
const BLOCKED = 'dashlint-test: network blocked';
const KEY_VAR = 'BOOKSHOP_POSTHOG_KEY';

interface Ran {
  code: number | null;
  out: string;
  err: string;
}

/** The built binary under the no-network hook. */
function binary(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Ran> {
  const r = spawnSync(process.execPath, ['--import', HOOK, BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      NO_COLOR: '1',
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      ...env,
    },
  });
  return Promise.resolve({ code: r.status, out: r.stdout, err: r.stderr });
}

/** The same command line through `run`, with a fetch that refuses and says so. */
async function inProcess(args: string[], cwd: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, {
    cwd,
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    fetch: () => {
      err.push(`${BLOCKED} (fetch)`);
      throw new Error(`${BLOCKED} (fetch)`);
    },
    sleep: () => Promise.resolve(),
  });
  const text = (lines: string[]) => (lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  return { code, out: text(out), err: text(err) };
}

let bin = binary;

// ---- The bookshop repo (spec 6.17): one web source in web/, the config at the root ----------------

const CONFIG = `version: 1
requirements: dashlint.requirements.json
platforms:
  posthog:
    host: https://eu.posthog.com
    project: 4242
    key: env:${KEY_VAR}
sources:
  - name: web
    path: web
    platform: web
failOn: dead
`;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
  },
  include: ['src'],
});

function shelf(wishlistEvent = 'wishlist_shared'): string {
  return [
    `import posthog from 'posthog-js';`,
    ``,
    `export function shareWishlist(genre: 'fiction' | 'poetry'): void {`,
    `  posthog.capture('${wishlistEvent}', { genre_id: genre, format: 'paperback' });`,
    `}`,
    ``,
    `export function completeOrder(): void {`,
    `  posthog.capture('order_completed', { format: 'ebook' });`,
    `}`,
    ``,
  ].join('\n');
}

const trends = (id: string, title: string, event: string, key?: string, value?: string) => ({
  id,
  title,
  kind: 'trends',
  series: [
    {
      ref: 'A',
      node: 'event',
      event,
      ...(key === undefined
        ? {}
        : { filters: [{ key, scope: 'event', op: 'exact', values: [value] }] }),
    },
  ],
});

const REQUIREMENTS = JSON.stringify(
  {
    schema: 'dashlint.requirements/1',
    source: { platform: 'posthog' },
    tiles: [
      trends(
        'insight:Wish01',
        'Wishlist shares, fiction',
        'wishlist_shared',
        'genre_id',
        'fiction',
      ),
      trends('insight:Ord02', 'Orders', 'order_completed'),
      trends('insight:Gift03', 'Gift cards redeemed', 'gift_card_redeemed'),
      // No call sends genre_id travel: dead, with the wishlist call as its code site.
      trends('insight:Trav04', 'Wishlist shares, travel', 'wishlist_shared', 'genre_id', 'travel'),
    ],
  },
  null,
  2,
);

function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', repo, '-c', 'user.name=Shop', '-c', 'user.email=shop@example.invalid', ...args],
    { encoding: 'utf8', stdio: 'pipe' },
  ).trim();
}

function write(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

function commit(repo: string, message: string, files: Record<string, string>): string {
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

let dir: string;
let repo: string;
let base: string;
/** This test's own temporary folder: diff's worktrees go here, not where other test files look. */
let tmp: string;
const savedTmp = process.env['TMPDIR'];
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'dashlint-e2e-'));
  tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  process.env['TMPDIR'] = tmp;
  repo = join(dir, 'shop');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'git@github.com:bookshop/shelf.git');
  base = commit(repo, 'base', {
    'dashlint.config.yml': CONFIG,
    'dashlint.requirements.json': REQUIREMENTS,
    'web/tsconfig.json': TSCONFIG,
    'web/src/shelf.ts': shelf(),
  });
});
afterEach(() => {
  if (savedTmp === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = savedTmp;
  // Every worktree diff made is gone again.
  expect(readdirSync(tmp)).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

/** The pull request: `wishlist_shared` renamed in the same function. */
const renamePr = () => commit(repo, 'rename', { 'web/src/shelf.ts': shelf('wishlist_sent') });

// ---- The hook ---------------------------------------------------------------------------------

describe('the no-network hook', () => {
  for (const [what, code] of [
    ['fetch', `await fetch('https://example.invalid/')`],
    ['net.connect', `(await import('node:net')).connect(443, 'example.invalid')`],
    ['dns.lookup', `(await import('node:dns')).lookup('example.invalid', () => {})`],
  ] as const)
    it(`fails ${what}`, async () => {
      const r = spawnSync(process.execPath, ['--import', HOOK, '--input-type=module', '-e', code], {
        encoding: 'utf8',
      });
      expect(r.stderr).toContain(`${BLOCKED} (${what})`);
      expect(r.status).not.toBe(0);
    });

  it('catches audit when it pulls (a key is set, so pull reaches for the network)', async () => {
    const r = await binary(['audit'], repo, { [KEY_VAR]: 'phx_not_a_real_key' });
    expect(r.err).toContain(BLOCKED);
    expect(r.code).not.toBe(0);
    expect(r.err).not.toContain('phx_not_a_real_key');
  });
});

// Each case runs twice: the built binary under the hook, and in process through `run` (coverage).
for (const [mode, runner] of [
  ['the built binary', binary],
  ['in process', inProcess],
] as const)
  // Each case extracts once or twice, through a child process: 30 s, not 5.
  describe(mode, { timeout: 30_000 }, () => {
    beforeEach(() => {
      bin = runner;
    });

    // ---- audit --------------------------------------------------------------------------------------

    describe('dashlint audit --offline, network blocked', () => {
      it('writes the HTML report, prints the text report and exits 1 for a dead tile', async () => {
        const r = await bin(['audit', '--offline'], repo);
        expect(r.err).not.toContain(BLOCKED);
        expect(r.code).toBe(1);
        const html = join(repo, 'dashlint-report.html');
        expect(r.err).toContain(`audit: wrote ${html}`);
        expect(r.out).toContain(`Report written to ${html}`);
        expect(r.out).toContain('Gift cards redeemed');
        expect(r.out.trimEnd().endsWith(CLOSING_SENTENCE)).toBe(true);
        const page = readFileSync(html, 'utf8');
        expect(page).toContain('Gift cards redeemed');
        // Code links point at the checked-out commit, repository-relative.
        expect(page).toContain(
          `https://github.com/bookshop/shelf/blob/${base}/web/src/shelf.ts#L4`,
        );
      });

      it('writes --out relative to the working directory and stays quiet with --quiet', async () => {
        const r = await bin(['audit', '--offline', '--out', 'reports/x.html', '--quiet'], repo);
        expect(r.code).toBe(2);
        expect(r.err).toContain('cannot write');
        mkdirSync(join(repo, 'reports'));
        const ok = await bin(['audit', '--offline', '--out', 'reports/x.html', '--quiet'], repo);
        expect(ok.code).toBe(1);
        expect(ok.err).toBe('');
        expect(existsSync(join(repo, 'reports/x.html'))).toBe(true);
      });

      it('--format json prints a dashlint.report/1 in mode audit', async () => {
        const r = await bin(['audit', '--offline', '--format', 'json'], repo);
        expect(r.err).not.toContain(BLOCKED);
        expect(r.code).toBe(1);
        const report = JSON.parse(r.out) as { mode: string; summary: { dead: number } };
        expect(validateReport(report).ok).toBe(true);
        expect(report.mode).toBe('audit');
        expect(report.summary.dead).toBe(2);
        expect(existsSync(join(repo, 'dashlint-report.html'))).toBe(false);
      });

      it('exits 0 when nothing is at or above failOn', async () => {
        write(repo, { 'dashlint.config.yml': CONFIG.replace('failOn: dead', 'failOn: never') });
        expect((await bin(['audit', '--offline', '--format', 'text'], repo)).code).toBe(0);
      });

      it('without the snapshot exits 2 naming the file', async () => {
        rmSync(join(repo, 'dashlint.requirements.json'));
        const r = await bin(['audit', '--offline'], repo);
        expect(r.code).toBe(2);
        expect(r.err).toContain(join(repo, 'dashlint.requirements.json'));
      });
    });

    describe('dashlint audit without --offline (spec negative control)', () => {
      it('exits 4 naming the missing variable, before any network use', async () => {
        const r = await bin(['audit'], repo);
        expect(r.code).toBe(4);
        expect(r.err).toContain(KEY_VAR);
        expect(r.err).not.toContain(BLOCKED);
        expect(existsSync(join(repo, 'dashlint-report.html'))).toBe(false);
      });

      it('an empty variable is missing too', async () => {
        const r = await bin(['audit'], repo, { [KEY_VAR]: '' });
        expect(r.code).toBe(4);
        expect(r.err).toContain(KEY_VAR);
      });
    });

    // ---- diff ---------------------------------------------------------------------------------------

    describe('dashlint diff, network blocked', () => {
      it('names the rename with its repository-relative site and fails the run', async () => {
        renamePr();
        const r = await bin(['diff', '--base', 'HEAD~1'], repo);
        expect(r.err).not.toContain(BLOCKED);
        expect(r.code).toBe(1);
        expect(r.out).toContain(`diff ${base.slice(0, 7)} to the working tree`);
        expect(r.out).toContain(
          commentText.renamed('wishlist_shared', 'wishlist_sent', 'web/src/shelf.ts:4'),
        );
        expect(r.out).toContain('"Wishlist shares, fiction"');
        // Gift cards and travel were dead before the change: counted, never failed (D5).
        expect(r.out).toContain(commentText.alreadyBroken(2, 'dead'));
        expect(r.out).toContain('1 tile newly dead, so this change fails the run.');
        expect(r.out.trimEnd().endsWith(CLOSING_SENTENCE)).toBe(true);
        expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
      });

      it('--head and --format markdown: the PR comment with its marker', async () => {
        const head = renamePr();
        git(repo, 'checkout', '-q', base);
        const r = await bin(['diff', '--base', base, '--head', head, '--format', 'markdown'], repo);
        expect(r.err).not.toContain(BLOCKED);
        expect(r.code).toBe(1);
        expect(r.out.startsWith(`${commentText.marker}\n`)).toBe(true);
        expect(r.out).toContain('`wishlist_shared` renamed to `wishlist_sent`');
        expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
      });

      it('a renamed event PostHog saw: the comment names the rename, not another producer', async () => {
        // ADR-060: the head report the comment reads is checked as the diff's verdicts are.
        const seen = JSON.parse(REQUIREMENTS) as Record<string, unknown>;
        seen['source'] = { platform: 'posthog', pulledAt: '2026-11-14T00:00:00.000Z' };
        seen['observed'] = {
          windowDays: 7,
          events: { wishlist_shared: { defined: true, lastSeenAt: '2026-11-13T00:00:00.000Z' } },
        };
        commit(repo, 'pull', { 'dashlint.requirements.json': JSON.stringify(seen, null, 2) });
        renamePr();
        const r = await bin(['diff', '--base', 'HEAD~1', '--format', 'markdown'], repo);
        expect(r.code).toBe(1);
        expect(r.out).toContain(
          `| ${commentText.renamed('wishlist_shared', 'wishlist_sent', 'web/src/shelf.ts:4')} | `,
        );
        expect(r.out).not.toContain(commentText.otherChanges);
        const json = await bin(['diff', '--base', 'HEAD~1', '--format', 'json'], repo);
        const report = JSON.parse(json.out) as { tiles: { id: string; verdict: string }[] };
        expect(report.tiles.find((t) => t.id === 'insight:Wish01')?.verdict).toBe('dead');
      });

      it('--format json prints the head report in mode diff', async () => {
        renamePr();
        const r = await bin(['diff', '--base', 'main~1', '--format', 'json'], repo);
        expect(r.code).toBe(1);
        const report = JSON.parse(r.out) as { mode: string; summary: { dead: number } };
        expect(validateReport(report).ok).toBe(true);
        expect(report.mode).toBe('diff');
        expect(report.summary.dead).toBe(3);
      });

      it('a change that touches no call exits 0', async () => {
        commit(repo, 'docs', { 'README.md': 'The bookshop.\n' });
        const r = await bin(['diff', '--base', 'HEAD~1'], repo);
        expect(r.code).toBe(0);
        expect(r.out).toContain('This change breaks no tiles or alerts.');
      });

      it('--base a catalog file: no git needed for the base', async () => {
        const out = join(dir, 'base.catalog.json');
        expect((await bin(['extract', '--out', out], repo)).code).toBe(0);
        renamePr();
        const r = await bin(['diff', '--base', out], repo);
        expect(r.err).not.toContain(BLOCKED);
        expect(r.code).toBe(1);
        expect(r.out).toContain('diff the base catalog to the working tree');
        // Without enclosing functions on the base, the rename reads as a removal.
        expect(r.out).toContain('`wishlist_shared` removed');
      });

      it('a source the base does not have yet is no catalog there, not an error', async () => {
        const kiosk = '  - name: kiosk\n    path: kiosk\n    platform: web\nfailOn: dead';
        write(repo, { 'dashlint.config.yml': CONFIG.replace('failOn: dead', kiosk) });
        commit(repo, 'kiosk', {
          'kiosk/tsconfig.json': TSCONFIG,
          'kiosk/src/k.ts': shelf('kiosk_opened'),
        });
        const r = await bin(['diff', '--base', base], repo);
        expect(r.err).toBe('');
        expect(r.code).toBe(0);
      });

      it('usage errors exit 2', async () => {
        const none = await bin(['diff'], repo);
        expect(none.code).toBe(2);
        expect(none.err).toContain('--base is missing');
        const bad = await bin(['diff', '--base', 'no-such-branch'], repo);
        expect(bad.code).toBe(2);
        expect(bad.err).toContain('`no-such-branch` is not a commit');
        const out = join(dir, 'base.catalog.json');
        await bin(['extract', '--out', out], repo);
        const mixed = await bin(['diff', '--base', out, '--head', 'HEAD'], repo);
        expect(mixed.code).toBe(2);
        expect(mixed.err).toContain('--head names a commit');
        rmSync(join(repo, '.git'), { recursive: true, force: true });
        const nogit = await bin(['diff', '--base', 'HEAD'], repo);
        expect(nogit.code).toBe(2);
        expect(nogit.err).toContain('is not in a git repository');
      });
    });
  });
