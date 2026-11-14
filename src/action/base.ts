// The base commit of the pull request (spec 6.10): `actions/checkout` fetches only the head by
// default, so the Action fetches the base itself at depth 1 when the checkout lacks it.
import { execFileSync } from 'node:child_process';

export interface FetchAuth {
  token: string;
  /** `GITHUB_SERVER_URL`, for example https://github.com. */
  serverUrl: string;
  /** `owner/name`. */
  repository: string;
}

/** A full commit id: only these are fetched, a branch or tag name is resolved by `diff` itself. */
export const isCommitId = (ref: string) => /^[0-9a-f]{40}$/i.test(ref);

function git(repo: string, args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function hasCommit(repo: string, sha: string): boolean {
  try {
    git(repo, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** git's own last stderr line; the token is never in it (it only travels in a header). */
const detail = (e: unknown): string => {
  const stderr = (e as { stderr?: Buffer | string }).stderr?.toString().trim() ?? '';
  return stderr.split('\n').pop() || (e instanceof Error ? e.message : String(e));
};

/**
 * Makes `sha` present in the checkout at `repo`: nothing when it is there already, else a depth 1
 * fetch from `origin` (the checkout's stored credentials), then with the token as a header.
 * Returns whether a fetch happened; throws with git's message when both fail.
 */
export function ensureCommit(repo: string, sha: string, auth: FetchAuth | null): boolean {
  if (hasCommit(repo, sha)) return false;
  const fetchArgs = ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1'];
  try {
    git(repo, [...fetchArgs, 'origin', sha]);
    return true;
  } catch (first) {
    if (auth === null || auth.token === '') throw new Error(detail(first));
    const basic = Buffer.from(`x-access-token:${auth.token}`).toString('base64');
    try {
      git(repo, [
        '-c',
        `http.extraheader=AUTHORIZATION: basic ${basic}`,
        ...fetchArgs,
        `${auth.serverUrl.replace(/\/+$/, '')}/${auth.repository}.git`,
        sha,
      ]);
      return true;
    } catch (second) {
      throw new Error(detail(second));
    }
  }
}
