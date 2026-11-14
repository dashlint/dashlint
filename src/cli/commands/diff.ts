// `dashlint diff --base <git-ref|catalog.json> [--head <git-ref>] [--format text|json|markdown]`
// (spec 6.7.5, 6.9.1): the base (and a head ref) extracted in temporary worktrees, both checked
// against the head's requirements; exit 1 only when a tile is newly broken at or above failOn (D5).
// No network (G4). Choices the spec leaves open: ADR-053.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  DiffGitError,
  checkContext,
  diffGit,
  diffResults,
  readAtCommit,
  resolveCommit,
  type DiffResult,
} from '../../check/index.js';
import { builtinTables } from '../../extract/merge.js';
import { enclosingFunctions } from '../../extract/enclosing.js';
import type { Catalog } from '../../formats/catalog.js';
import type { Requirements } from '../../formats/requirements.js';
import { formatValidationErrors } from '../../formats/validate.js';
import { loadRequirements } from '../../formats/yaml.js';
import { renderDiffText } from '../../report/diff-text.js';
import { renderJson } from '../../report/json.js';
import { renderComment, type CommentInput } from '../../report/markdown.js';
import { cliMessages, reportText } from '../../report/messages.js';
import { usageError, type FailOn, type ParsedArgs } from '../args.js';
import type { Config } from '../config.js';
import { checkModel, configCatalogs } from './check.js';
import {
  descriptors,
  extractSource,
  info,
  print,
  readCatalog,
  readConfig,
  readRequirements,
  type CommandContext,
} from './common.js';

const slash = (p: string) => p.split('\\').join('/');

/** A path under the config's folder with symlinks resolved, as git's toplevel is. */
const inRepo = (file: string) => join(realpathSync(dirname(file)), basename(file));

function toplevel(dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw usageError(cliMessages.diffNotGit(dir));
  }
}

const commitOf = (repo: string, ref: string): string => {
  try {
    return resolveCommit(repo, ref);
  } catch (e) {
    if (e instanceof DiffGitError) throw usageError(e.message);
    throw e;
  }
};

/** The head's requirements: the file in the working tree, or its copy at `--head`. */
function headRequirements(config: Config, repo: string, head: string | null): Requirements {
  if (head === null) return readRequirements(config.requirements);
  const path = slash(relative(repo, inRepo(config.requirements)));
  const text = readAtCommit(repo, head, path);
  if (text === undefined) throw usageError(cliMessages.noRequirementsAt(path, head));
  const r = loadRequirements(text);
  if (!r.ok)
    throw usageError(
      formatValidationErrors(r.errors)
        .map((e) => cliMessages.fileInvalid(`${head.slice(0, 7)}:${path}`, e))
        .join('\n'),
    );
  return r.value;
}

export interface DiffOptions {
  base: string;
  head?: string;
  /** Replaces the config's failOn (the Action's `fail-on` input). */
  failOn?: FailOn;
}

/** Runs the diff once; the CLI and the Action render it (T8.1). */
export function diffRun(opts: DiffOptions, ctx: CommandContext): CommentInput {
  const { base } = opts;
  const headRef = opts.head;
  const config = readConfig(ctx, 'diff');
  if (config.sources.length === 0 && config.catalogs.length === 0)
    throw usageError(cliMessages.noSources);

  const all = descriptors();
  const tables = builtinTables(all);
  const contextFor = (catalogs: readonly Catalog[], requirements: Requirements) =>
    checkContext(catalogs, requirements, tables);
  const now = new Date(ctx.now?.() ?? Date.now());
  const common = {
    contextFor,
    failOn: opts.failOn ?? config.failOn,
    ignore: config.ignore,
    now,
  };

  let diff: DiffResult;
  let requirements: Requirements;
  let headCatalogs: readonly Catalog[];
  const baseFile = resolve(ctx.cwd, base);
  if (base.toLowerCase().endsWith('.json') && existsSync(baseFile) && statSync(baseFile).isFile()) {
    // A catalog file as the base: no git, the requirements' change and renames are unknown.
    if (headRef !== undefined) throw usageError(cliMessages.diffHeadNeedsGit);
    requirements = readRequirements(config.requirements);
    headCatalogs = configCatalogs(ctx, config, all);
    diff = diffResults({
      requirements,
      base: {
        catalogs: [readCatalog(baseFile), ...config.catalogs.map(readCatalog)],
        commit: null,
      },
      head: { catalogs: headCatalogs, commit: null },
      ...common,
    });
  } else {
    const repo = toplevel(config.dir);
    const configRel = relative(repo, realpathSync(config.dir));
    const baseCommit = commitOf(repo, base);
    const headCommit = headRef === undefined ? null : commitOf(repo, headRef);
    requirements = headRequirements(config, repo, headCommit);
    const byCommit = new Map<string | null, Catalog[]>();
    const catalogsAt = (root: string, commit: string | null): Catalog[] => {
      const dir = join(root, configRel);
      const checkout = root !== repo;
      const catalogs = [
        ...config.sources
          // A source this side does not have yet (an app the change adds) gives no catalog.
          .filter((s) => !checkout || existsSync(join(dir, s.path)))
          .map((s) => extractSource(ctx, config, s, all, { dir, commit })),
        ...config.catalogs.map(readCatalog),
      ];
      byCommit.set(commit, catalogs);
      return catalogs;
    };
    try {
      diff = diffGit({
        repoRoot: repo,
        base: baseCommit,
        ...(headCommit === null ? {} : { head: headCommit }),
        requirements,
        requirementsPath: slash(relative(repo, inRepo(config.requirements))),
        catalogsAt,
        enclosingIn: (root) => enclosingFunctions(join(root, configRel)),
        ...common,
      });
    } catch (e) {
      if (e instanceof DiffGitError) throw usageError(e.message);
      throw e;
    }
    headCatalogs = byCommit.get(headCommit) ?? [];
  }

  const head = checkModel(ctx, {
    mode: 'diff',
    catalogs: headCatalogs,
    requirements,
    ignore: config.ignore,
    all,
  });
  return { diff, head, requirementsFile: slash(relative(config.dir, config.requirements)) };
}

export function diffCommand(flags: ParsedArgs['flags'], ctx: CommandContext): number {
  const base = flags.base as string | undefined;
  if (base === undefined) throw usageError(cliMessages.diffNeedsBase);
  const head = flags.head as string | undefined;
  const format = (flags.format as 'text' | 'json' | 'markdown' | undefined) ?? 'text';
  const input = diffRun({ base, ...(head === undefined ? {} : { head }) }, ctx);
  const { diff } = input;
  if (format === 'text') print(ctx, renderDiffText(input));
  else {
    print(ctx, format === 'json' ? renderJson(input.head) : renderComment(input));
    // The text output has them; the JSON and the comment do not (ADR-049).
    for (const w of diff.warnings)
      info(
        ctx,
        cliMessages.warning(
          'diff',
          w.code === 'ignore-expired'
            ? reportText.ignoreExpired(w.entry.id, w.entry.until ?? '')
            : reportText.ignoreUnmatched(w.entry.id),
        ),
      );
  }
  return diff.fails ? 1 : 0;
}
