// What the Action needs from GitHub (spec 6.10, D4): the pull request from the event file and the
// one marked comment through the REST API with the given token. Nothing else is called (G4).
import { readFileSync } from 'node:fs';

/** The pull request the workflow runs for. */
export interface PullRequest {
  number: number;
  baseSha: string;
  /** A fork or Dependabot pull request: `GITHUB_TOKEN` is read-only there [F14]. */
  readOnly: boolean;
}

interface EventRepo {
  full_name?: string;
}

interface PullRequestEvent {
  repository?: EventRepo;
  pull_request?: {
    number?: number;
    base?: { sha?: string; repo?: EventRepo | null };
    head?: { repo?: EventRepo | null };
    user?: { login?: string };
  };
}

const DEPENDABOT = 'dependabot[bot]';

/** The event file's JSON, or undefined when there is none. */
export function readEvent(path: string | undefined): unknown {
  if (path === undefined || path === '') return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** The pull request of a `pull_request` event; null for any other event. */
export function pullRequestOf(
  eventName: string | undefined,
  event: unknown,
  actor: string | undefined,
): PullRequest | null {
  if (eventName !== 'pull_request') return null;
  const e = (event ?? {}) as PullRequestEvent;
  const pr = e.pull_request;
  if (pr?.number === undefined || pr.base?.sha === undefined) return null;
  const own = e.repository?.full_name ?? pr.base.repo?.full_name;
  // A deleted fork leaves no head repository: still not this repository.
  const fork = own === undefined || pr.head?.repo?.full_name !== own;
  const dependabot = actor === DEPENDABOT || pr.user?.login === DEPENDABOT;
  return { number: pr.number, baseSha: pr.base.sha, readOnly: fork || dependabot };
}

/** A REST call that did not succeed: `status` 0 when no response came back. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface IssueComment {
  id: number;
  body: string;
  html_url: string;
}

export interface GitHubOptions {
  token: string;
  /** `GITHUB_API_URL`, for example https://api.github.com. */
  apiUrl: string;
  /** `owner/name`. */
  repository: string;
  fetch?: typeof fetch;
}

export interface GitHub {
  listComments(issue: number): Promise<IssueComment[]>;
  createComment(issue: number, body: string): Promise<IssueComment>;
  updateComment(id: number, body: string): Promise<IssueComment>;
}

const PAGE = 100;

export function gitHub(o: GitHubOptions): GitHub {
  const doFetch = o.fetch ?? fetch;
  const root = `${o.apiUrl.replace(/\/+$/, '')}/repos/${o.repository}`;
  async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
    let res: Response;
    try {
      res = await doFetch(`${root}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${o.token}`,
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new GitHubError(0, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw new GitHubError(res.status, `${method} ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    async listComments(issue) {
      const all: IssueComment[] = [];
      for (let page = 1; ; page++) {
        const batch = await call<IssueComment[]>(
          'GET',
          `/issues/${issue}/comments?per_page=${PAGE}&page=${page}`,
        );
        all.push(...batch);
        if (batch.length < PAGE) return all;
      }
    },
    createComment: (issue, body) =>
      call<IssueComment>('POST', `/issues/${issue}/comments`, { body }),
    updateComment: (id, body) => call<IssueComment>('PATCH', `/issues/comments/${id}`, { body }),
  };
}
