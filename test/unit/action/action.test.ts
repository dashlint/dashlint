// The Action's main (T8.1, spec 6.10, D4): a bookshop git repo, the event file the runner writes and
// a fake GitHub REST API behind `fetch`. Same-repo pull requests get one marked comment, created then
// updated; fork and Dependabot pull requests get the summary only; a no-op changes no comment; a 403
// degrades to the summary with a note instead of failing.
import { execFileSync } from 'node:child_process';
import {
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCommit, isCommitId } from '../../../src/action/base.js';
import { gitHub, pullRequestOf, type IssueComment } from '../../../src/action/github.js';
import { runAction, type ActionEnv } from '../../../src/action/main.js';
import { validateReport } from '../../../src/formats/validate.js';
import { actionText, CLOSING_SENTENCE, commentText } from '../../../src/report/messages.js';

const TOKEN = 'ghs_bookshopFakeToken000';
const REPO = 'bookshop/shelf';
const API = 'https://api.github.invalid';

// ---- The bookshop repo (spec 6.17) ------------------------------------------------------------------

const CONFIG = `version: 1
requirements: dashlint.requirements.json
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

function shelf(wishlistEvent = 'wishlist_shared', orderEvent = 'order_completed'): string {
  return [
    `import posthog from 'posthog-js';`,
    ``,
    `export function shareWishlist(genre: 'fiction' | 'poetry'): void {`,
    `  posthog.capture('${wishlistEvent}', { genre_id: genre });`,
    `}`,
    ``,
    `export function completeOrder(): void {`,
    `  posthog.capture('${orderEvent}', { format: 'ebook' });`,
    `}`,
    ``,
  ].join('\n');
}

const trends = (id: string, title: string, event: string) => ({
  id,
  title,
  kind: 'trends',
  series: [{ ref: 'A', node: 'event', event }],
});

const REQUIREMENTS = JSON.stringify({
  schema: 'dashlint.requirements/1',
  source: { platform: 'posthog' },
  tiles: [
    trends('insight:Wish01', 'Wishlist shares', 'wishlist_shared'),
    trends('insight:Ord02', 'Orders', 'order_completed'),
  ],
});

function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', repo, '-c', 'user.name=Shop', '-c', 'user.email=shop@example.invalid', ...args],
    { encoding: 'utf8', stdio: 'pipe' },
  ).trim();
}

function commit(repo: string, message: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

// ---- The fake GitHub API ----------------------------------------------------------------------------

interface FakeOptions {
  /** Answers this method with this status instead (a read-only token, a missing permission). */
  refuse?: { method: string; status: number };
  /** Comments already on the pull request. */
  comments?: IssueComment[];
}

function fakeGitHub(o: FakeOptions = {}) {
  const comments: IssueComment[] = [...(o.comments ?? [])];
  const calls: string[] = [];
  let nextId = 1000;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== `Bearer ${TOKEN}`) return json(401, {});
    if (o.refuse?.method === method)
      return json(o.refuse.status, { message: 'Resource not accessible by integration' });
    const list = u.pathname.match(/^\/repos\/bookshop\/shelf\/issues\/(\d+)\/comments$/);
    if (list !== null && method === 'GET') {
      const page = Number(u.searchParams.get('page'));
      const per = Number(u.searchParams.get('per_page'));
      return json(200, comments.slice((page - 1) * per, page * per));
    }
    if (list !== null && method === 'POST') {
      const id = nextId++;
      const body = (JSON.parse(String(init?.body)) as { body: string }).body;
      const c = { id, body, html_url: `https://github.invalid/${REPO}/pull/7#c${id}` };
      comments.push(c);
      return json(201, c);
    }
    const one = u.pathname.match(/^\/repos\/bookshop\/shelf\/issues\/comments\/(\d+)$/);
    if (one !== null && method === 'PATCH') {
      const c = comments.find((x) => x.id === Number(one[1]));
      if (c === undefined) return json(404, {});
      c.body = (JSON.parse(String(init?.body)) as { body: string }).body;
      return json(200, c);
    }
    return json(404, {});
  }) as typeof globalThis.fetch;
  return { comments, calls, fetch };
}

// ---- One run of the Action ---------------------------------------------------------------------------

let dir: string;
let repo: string;
let base: string;
let tmp: string;
const savedTmp = process.env['TMPDIR'];

interface PrShape {
  headRepo?: string | null;
  user?: string;
  actor?: string;
  event?: string;
}

function event(shape: PrShape = {}): string {
  const file = join(dir, 'event.json');
  writeFileSync(
    file,
    JSON.stringify({
      repository: { full_name: REPO },
      pull_request: {
        number: 7,
        base: { sha: base, repo: { full_name: REPO } },
        head: { repo: shape.headRepo === null ? null : { full_name: shape.headRepo ?? REPO } },
        user: { login: shape.user ?? 'reader' },
      },
    }),
  );
  return file;
}

async function act(
  fake: ReturnType<typeof fakeGitHub>,
  shape: PrShape = {},
  inputs: Record<string, string> = {},
) {
  const summary = join(dir, 'summary.md');
  const output = join(dir, 'output.txt');
  writeFileSync(summary, '');
  writeFileSync(output, '');
  const env: ActionEnv = {
    GITHUB_WORKSPACE: repo,
    GITHUB_EVENT_NAME: shape.event ?? 'pull_request',
    GITHUB_EVENT_PATH: event(shape),
    GITHUB_REPOSITORY: REPO,
    GITHUB_API_URL: API,
    // A fetch with the token goes here: a missing local path, so no test reaches a network.
    GITHUB_SERVER_URL: `file://${dir}/no-server`,
    GITHUB_ACTOR: shape.actor ?? 'reader',
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_OUTPUT: output,
    RUNNER_TEMP: dir,
    INPUT_CONFIG: 'dashlint.config.yml',
    INPUT_BASE: '',
    'INPUT_FAIL-ON': '',
    INPUT_COMMENT: 'true',
    INPUT_TOKEN: TOKEN,
    ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
  };
  const log: string[] = [];
  const code = await runAction(env, { log: (l) => log.push(l), fetch: fake.fetch, tool: '0.1.0' });
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { code, log: log.join('\n'), summary: readFileSync(summary, 'utf8'), outputs };
}

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'dashlint-action-'));
  tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  process.env['TMPDIR'] = tmp;
  repo = join(dir, 'shop');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
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
  expect(readdirSync(tmp)).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

const renamePr = () => commit(repo, 'rename', { 'web/src/shelf.ts': shelf('wishlist_sent') });

describe('the Action on a same-repo pull request', { timeout: 30_000 }, () => {
  it('creates the one marked comment, then updates it in place', async () => {
    renamePr();
    const fake = fakeGitHub();
    const first = await act(fake);
    expect(first.code).toBe(1);
    expect(fake.comments).toHaveLength(1);
    const body = fake.comments[0]?.body ?? '';
    expect(body.startsWith(`${commentText.marker}\n`)).toBe(true);
    expect(body).toContain('**dashlint: this PR would break 1 tile**');
    expect(body).toContain('`wishlist_shared` renamed to `wishlist_sent` (web/src/shelf.ts:4)');
    expect(body).toContain(commentText.footer('0.1.0'));
    expect(fake.calls).toEqual([
      `GET /repos/${REPO}/issues/7/comments?per_page=100&page=1`,
      `POST /repos/${REPO}/issues/7/comments`,
    ]);
    expect(first.log).toContain(
      actionText.commented(`https://github.invalid/${REPO}/pull/7#c1000`),
    );
    expect(first.log).toContain('::error::dashlint: 1 tile is newly broken');
    // The summary is the comment, always, with no note when the comment was written.
    expect(first.summary).toBe(body);
    expect(first.outputs['newly-broken']).toBe('1');
    const report = JSON.parse(readFileSync(first.outputs['report-json'] ?? '', 'utf8')) as unknown;
    expect(validateReport(report).ok).toBe(true);
    expect((report as { mode: string }).mode).toBe('diff');

    // The same head again: the comment is already right, nothing is written.
    fake.calls.length = 0;
    const again = await act(fake);
    expect(again.code).toBe(1);
    expect(fake.calls).toEqual([`GET /repos/${REPO}/issues/7/comments?per_page=100&page=1`]);
    expect(again.log).toContain(actionText.unchanged);

    // A second push breaks one more tile: the same comment is updated, no second one appears.
    commit(repo, 'and orders', { 'web/src/shelf.ts': shelf('wishlist_sent', 'order_done') });
    fake.calls.length = 0;
    const updated = await act(fake);
    expect(updated.code).toBe(1);
    expect(fake.calls).toEqual([
      `GET /repos/${REPO}/issues/7/comments?per_page=100&page=1`,
      `PATCH /repos/${REPO}/issues/comments/1000`,
    ]);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]?.body).toContain('**dashlint: this PR would break 2 tiles**');
    expect(updated.outputs['newly-broken']).toBe('2');

    // The fix: the comment says so instead of disappearing.
    commit(repo, 'fix', { 'web/src/shelf.ts': shelf() });
    const fixed = await act(fake);
    expect(fixed.code).toBe(0);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]?.body).toContain('**dashlint: this PR breaks no tiles or alerts**');
    expect(fixed.outputs['newly-broken']).toBe('0');
  });

  it('finds its comment on a later page among other comments', async () => {
    renamePr();
    const others = Array.from({ length: 130 }, (_, i) => ({
      id: i + 1,
      body: i === 120 ? `${commentText.marker}\nold` : `a reader's note ${i}`,
      html_url: `https://github.invalid/${REPO}/pull/7#c${i + 1}`,
    }));
    const fake = fakeGitHub({ comments: others });
    const r = await act(fake);
    expect(r.code).toBe(1);
    expect(fake.calls).toEqual([
      `GET /repos/${REPO}/issues/7/comments?per_page=100&page=1`,
      `GET /repos/${REPO}/issues/7/comments?per_page=100&page=2`,
      `PATCH /repos/${REPO}/issues/comments/121`,
    ]);
    expect(fake.comments).toHaveLength(130);
    expect(fake.comments[120]?.body).toContain('would break 1 tile');
  });

  it('a no-op pull request changes no comment and passes', async () => {
    commit(repo, 'docs', { 'README.md': 'The bookshop.\n' });
    const fake = fakeGitHub();
    const r = await act(fake);
    expect(r.code).toBe(0);
    expect(fake.comments).toEqual([]);
    expect(fake.calls).toEqual([`GET /repos/${REPO}/issues/7/comments?per_page=100&page=1`]);
    expect(r.log).toContain(actionText.nothingToSay);
    expect(r.log).not.toContain('::error::');
    expect(r.summary).toContain('**dashlint: this PR breaks no tiles or alerts**');
    expect(r.outputs['newly-broken']).toBe('0');
  });

  it('fail-on never reports the break and passes; a bad fail-on is exit 2', async () => {
    renamePr();
    const r = await act(fakeGitHub(), {}, { 'fail-on': 'never' });
    expect(r.code).toBe(0);
    expect(r.outputs['newly-broken']).toBe('0');
    expect(r.summary).toContain('would break 1 tile');
    const bad = await act(fakeGitHub(), {}, { 'fail-on': 'sometimes' });
    expect(bad.code).toBe(2);
    expect(bad.log).toContain(
      actionText.badFailOn('sometimes', ['dead', 'partly-dead', 'degraded', 'never']),
    );
  });

  it('comment false writes the summary only and says so', async () => {
    renamePr();
    const fake = fakeGitHub();
    const r = await act(fake, {}, { comment: 'false' });
    expect(r.code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(r.summary).toContain(actionText.commentOff);
  });
});

describe('fork and Dependabot pull requests: summary only', { timeout: 30_000 }, () => {
  it('a fork pull request never calls the API and says why', async () => {
    renamePr();
    const fake = fakeGitHub();
    const r = await act(fake, { headRepo: 'reader/shelf' });
    expect(r.code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(r.summary).toContain('would break 1 tile');
    expect(r.summary).toContain(actionText.readOnly);
    expect(r.outputs['newly-broken']).toBe('1');
  });

  it('a deleted fork (no head repository) is read-only too', async () => {
    renamePr();
    const fake = fakeGitHub();
    const r = await act(fake, { headRepo: null });
    expect(fake.calls).toEqual([]);
    expect(r.summary).toContain(actionText.readOnly);
  });

  it('a Dependabot pull request, by author or by actor, gets the summary only', async () => {
    renamePr();
    for (const shape of [{ user: 'dependabot[bot]' }, { actor: 'dependabot[bot]' }]) {
      const fake = fakeGitHub();
      const r = await act(fake, shape);
      expect(fake.calls).toEqual([]);
      expect(r.summary).toContain(actionText.readOnly);
    }
  });
});

describe('a token that cannot write (spec negative control)', { timeout: 30_000 }, () => {
  it('a 403 on creating the comment degrades to the summary with the note', async () => {
    renamePr();
    const fake = fakeGitHub({ refuse: { method: 'POST', status: 403 } });
    const r = await act(fake);
    // The run's result is the diff's, not the comment's.
    expect(r.code).toBe(1);
    expect(fake.comments).toEqual([]);
    expect(r.summary).toContain('would break 1 tile');
    expect(r.summary).toContain(actionText.commentFailed('HTTP 403'));
    expect(r.log).not.toContain('unexpected error');
    expect(r.outputs['newly-broken']).toBe('1');
  });

  it('a 403 on a no-op pull request still passes', async () => {
    commit(repo, 'docs', { 'README.md': 'The bookshop.\n' });
    const r = await act(fakeGitHub({ refuse: { method: 'GET', status: 403 } }));
    expect(r.code).toBe(0);
    expect(r.summary).toContain(actionText.commentFailed('HTTP 403'));
  });

  it('a network failure to the API degrades the same way', async () => {
    renamePr();
    const failing = {
      ...fakeGitHub(),
      fetch: (() => Promise.reject(new Error('socket hang up'))) as typeof fetch,
    };
    const r = await act(failing);
    expect(r.code).toBe(1);
    expect(r.summary).toContain(actionText.commentFailed('socket hang up'));
  });

  it('the token never reaches the log, the summary or the outputs', async () => {
    renamePr();
    const r = await act(fakeGitHub({ refuse: { method: 'POST', status: 403 } }));
    expect(`${r.log}${r.summary}${JSON.stringify(r.outputs)}`).not.toContain(TOKEN);
  });
});

describe('other events and the base input', { timeout: 30_000 }, () => {
  it('a push event without a base input checks nothing and passes', async () => {
    const fake = fakeGitHub();
    const r = await act(fake, { event: 'push' });
    expect(r.code).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(r.summary).toContain(actionText.notPullRequest('push'));
    expect(r.outputs['newly-broken']).toBe('0');
  });

  it('a push event with a base input runs the diff but comments nowhere', async () => {
    renamePr();
    const fake = fakeGitHub();
    const r = await act(fake, { event: 'push' }, { base: 'main~1' });
    expect(r.code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(r.summary).toContain('would break 1 tile');
  });

  it('a config mistake is exit 2 with the CLI message as an error annotation', async () => {
    renamePr();
    const r = await act(fakeGitHub(), {}, { config: 'missing.yml' });
    expect(r.code).toBe(2);
    expect(r.log).toMatch(/^::error::dashlint diff: cannot read the config .*missing\.yml/m);
  });

  it('every summary ends with the closing sentence (G11)', async () => {
    renamePr();
    const r = await act(fakeGitHub());
    expect(r.summary.toLowerCase()).toContain(CLOSING_SENTENCE.slice(1, -1));
  });
});

describe('the base commit', { timeout: 30_000 }, () => {
  it('a depth 1 checkout gets the base fetched, then the diff runs', async () => {
    renamePr();
    const origin = repo;
    repo = join(dir, 'checkout');
    execFileSync('git', ['clone', '-q', '--depth=1', `file://${origin}`, repo]);
    expect(() => git(repo, 'cat-file', '-e', `${base}^{commit}`)).toThrow();
    const r = await act(fakeGitHub());
    expect(r.code).toBe(1);
    expect(git(repo, 'cat-file', '-t', base)).toBe('commit');
    expect(r.summary).toContain('would break 1 tile');
  });

  it('ensureCommit does nothing when the commit is there', () => {
    expect(ensureCommit(repo, base, null)).toBe(false);
  });

  it('a base that cannot be fetched is exit 2 naming the commit, never the token', async () => {
    const missing = 'f'.repeat(40);
    const fake = fakeGitHub();
    const r = await act(fake, {}, { base: missing });
    expect(r.code).toBe(2);
    expect(r.log).toContain('::error::');
    expect(r.log).toContain(`could not fetch the base commit ${missing.slice(0, 7)}`);
    expect(r.log).not.toContain(TOKEN);
  });

  it('only full commit ids are fetched', () => {
    expect(isCommitId(base)).toBe(true);
    expect(isCommitId('main~1')).toBe(false);
    expect(isCommitId(base.slice(0, 7))).toBe(false);
  });
});

describe('pullRequestOf and the REST client', () => {
  const pr = (headRepo: string | null) => ({
    repository: { full_name: REPO },
    pull_request: {
      number: 3,
      base: { sha: 'a'.repeat(40) },
      head: { repo: headRepo === null ? null : { full_name: headRepo } },
    },
  });

  it('reads the number and base, and whether the token is read-only', () => {
    expect(pullRequestOf('pull_request', pr(REPO), 'reader')).toEqual({
      number: 3,
      baseSha: 'a'.repeat(40),
      readOnly: false,
    });
    expect(pullRequestOf('pull_request', pr('reader/shelf'), 'reader')?.readOnly).toBe(true);
    expect(pullRequestOf('pull_request', pr(null), 'reader')?.readOnly).toBe(true);
    expect(pullRequestOf('pull_request', pr(REPO), 'dependabot[bot]')?.readOnly).toBe(true);
  });

  it('only a pull_request event is a pull request', () => {
    for (const name of ['push', 'workflow_dispatch', 'pull_request_review', undefined])
      expect(pullRequestOf(name, pr(REPO), 'reader')).toBeNull();
    expect(pullRequestOf('pull_request', {}, 'reader')).toBeNull();
  });

  it('sends the token as a bearer header to the configured API only', async () => {
    const fake = fakeGitHub();
    const api = gitHub({ token: TOKEN, apiUrl: `${API}/`, repository: REPO, fetch: fake.fetch });
    const c = await api.createComment(7, 'hello');
    expect(c.body).toBe('hello');
    expect(fake.calls).toEqual([`POST /repos/${REPO}/issues/7/comments`]);
    const wrong = gitHub({ token: 'other', apiUrl: API, repository: REPO, fetch: fake.fetch });
    await expect(wrong.listComments(7)).rejects.toMatchObject({ status: 401 });
  });
});
