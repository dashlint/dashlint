// Entry point for the GitHub Action bundle (dist/action.mjs, spec 6.10, 6.11, D3, D4): fetches the
// pull request's base commit, runs `diff` once, writes the job summary always, and creates or updates
// the one marked comment when the token can write. Fork and Dependabot pull requests get the summary
// only, and say so. Never needs an analytics key or a secret; calls only the GitHub REST API (G4).
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliError } from '../cli/args.js';
import { diffRun } from '../cli/commands/diff.js';
import { FAIL_ON, type FailOn } from '../check/diff.js';
import { renderDiffText } from '../report/diff-text.js';
import { renderJson } from '../report/json.js';
import { renderComment } from '../report/markdown.js';
import { actionText, cliMessages, commentText } from '../report/messages.js';
import { ensureCommit, isCommitId } from './base.js';
import { GitHubError, gitHub, pullRequestOf, readEvent, type GitHub } from './github.js';

/** Set by the bundle build (scripts/build.mjs); the source tree reads package.json instead. */
declare const __DASHLINT_VERSION__: string | undefined;

function version(): string {
  if (typeof __DASHLINT_VERSION__ === 'string') return __DASHLINT_VERSION__;
  const file = fileURLToPath(new URL('../../package.json', import.meta.url));
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

export type ActionEnv = Readonly<Record<string, string | undefined>>;

export interface ActionDeps {
  /** The log (the step's stdout). */
  log: (line: string) => void;
  /** The GitHub REST client; built from the token and `GITHUB_API_URL` when absent. */
  github?: GitHub;
  fetch?: typeof fetch;
  tool?: string;
  now?: () => number;
}

/** An input as the runner passes it: `INPUT_` and the name in capitals, hyphens kept. */
const input = (env: ActionEnv, name: string): string =>
  (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();

/** A workflow command's message: `%`, CR and LF would end or garble it. */
const escapeCommand = (s: string) =>
  s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function setOutput(env: ActionEnv, log: ActionDeps['log'], name: string, value: string): void {
  const file = env['GITHUB_OUTPUT'];
  if (file) appendFileSync(file, `${name}=${value}\n`);
  else log(`${name}=${value}`);
}

function writeSummary(env: ActionEnv, log: ActionDeps['log'], text: string): void {
  const file = env['GITHUB_STEP_SUMMARY'];
  if (file) appendFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  else log(text);
}

/** What happened to the comment, and the note the summary carries when there is none. */
interface CommentOutcome {
  note?: string;
  line?: string;
}

async function upsertComment(
  api: GitHub,
  issue: number,
  body: string,
  worse: number,
): Promise<CommentOutcome> {
  try {
    const mine = (await api.listComments(issue)).find((c) => c.body.startsWith(commentText.marker));
    if (mine !== undefined) {
      if (mine.body === body) return { line: actionText.unchanged };
      const updated = await api.updateComment(mine.id, body);
      return { line: actionText.updated(updated.html_url) };
    }
    // A pull request that breaks nothing gets no comment (a no-op stays quiet).
    if (worse === 0) return { line: actionText.nothingToSay };
    const created = await api.createComment(issue, body);
    return { line: actionText.commented(created.html_url) };
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    return { note: actionText.commentFailed(e.status === 0 ? e.message : `HTTP ${e.status}`) };
  }
}

/** Runs the Action; returns the exit code (1 when a tile is newly broken at or above failOn). */
export async function runAction(env: ActionEnv, deps: ActionDeps): Promise<number> {
  const { log } = deps;
  const fail = (message: string, code: number) => {
    log(`::error::${escapeCommand(message)}`);
    return code;
  };
  try {
    const failOnInput = input(env, 'fail-on');
    if (failOnInput !== '' && !(FAIL_ON as readonly string[]).includes(failOnInput))
      return fail(actionText.badFailOn(failOnInput, FAIL_ON), 2);
    const failOn = failOnInput === '' ? undefined : (failOnInput as FailOn);
    const wantComment = input(env, 'comment').toLowerCase() !== 'false';
    const token = input(env, 'token');
    const repository = env['GITHUB_REPOSITORY'] ?? '';
    const cwd = env['GITHUB_WORKSPACE'] || process.cwd();

    const eventName = env['GITHUB_EVENT_NAME'];
    const pr = pullRequestOf(eventName, readEvent(env['GITHUB_EVENT_PATH']), env['GITHUB_ACTOR']);
    const base = input(env, 'base') || pr?.baseSha;
    if (base === undefined) {
      const text = actionText.notPullRequest(eventName ?? 'unknown');
      log(text);
      writeSummary(env, log, text);
      setOutput(env, log, 'newly-broken', '0');
      return 0;
    }
    if (isCommitId(base)) {
      try {
        ensureCommit(
          cwd,
          base,
          token === ''
            ? null
            : { token, serverUrl: env['GITHUB_SERVER_URL'] || 'https://github.com', repository },
        );
      } catch (e) {
        return fail(actionText.baseFetchFailed(base, e instanceof Error ? e.message : ''), 2);
      }
    }

    const tool = deps.tool ?? version();
    const configInput = input(env, 'config');
    const result = diffRun(
      { base, ...(failOn === undefined ? {} : { failOn }) },
      {
        cwd,
        env: {},
        tool,
        quiet: false,
        stdout: log,
        stderr: log,
        ...(configInput === '' ? {} : { config: configInput }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      },
    );
    const { diff } = result;
    log(renderDiffText(result).replace(/\n$/, ''));

    const reportJson = join(env['RUNNER_TEMP'] || tmpdir(), 'dashlint-report.json');
    writeFileSync(reportJson, renderJson(result.head));

    const body = renderComment(result);
    let outcome: CommentOutcome = {};
    if (!wantComment) outcome = { note: actionText.commentOff };
    else if (pr !== null && pr.readOnly) outcome = { note: actionText.readOnly };
    else if (pr !== null) {
      const api =
        deps.github ??
        gitHub({
          token,
          apiUrl: env['GITHUB_API_URL'] || 'https://api.github.com',
          repository,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        });
      outcome = await upsertComment(
        api,
        pr.number,
        body,
        diff.worse.length + diff.alerts.worse.length,
      );
    }
    if (outcome.line !== undefined) log(outcome.line);
    if (outcome.note !== undefined) log(outcome.note);
    writeSummary(env, log, outcome.note === undefined ? body : `${body}\n${outcome.note}\n`);

    const newlyBroken = diff.worse.filter((c) => c.fails).length;
    setOutput(env, log, 'newly-broken', String(newlyBroken));
    setOutput(env, log, 'report-json', reportJson);
    return diff.fails ? fail(actionText.fails(newlyBroken), 1) : 0;
  } catch (e) {
    if (e instanceof CliError && e.exitCode !== 3)
      return fail(cliMessages.prefix('diff', e.message), e.exitCode);
    return fail(cliMessages.bug('diff', e instanceof Error ? e.message : String(e)), 3);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runAction(process.env, {
    log: (line) => process.stdout.write(`${line}\n`),
  });
}
