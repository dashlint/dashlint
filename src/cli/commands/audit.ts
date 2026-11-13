// `dashlint audit [--offline] [--out <file>] [--format html|json|text]` (spec 6.9.1): pull (unless
// --offline), extract, check. The HTML report goes to --out (default dashlint-report.html) and the
// text report to the terminal; json and text go to --out or the terminal. Only `pull` touches the
// network (G4). Choices the spec leaves open: ADR-053.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { HtmlOptions } from '../../report/html.js';
import { renderText } from '../../report/text.js';
import type { FailOn, ParsedArgs } from '../args.js';
import { configCatalogs, checkModel, emitReport, failsAt } from './check.js';
import {
  configFile,
  descriptors,
  info,
  print,
  readConfig,
  readRequirements,
  type CommandContext,
} from './common.js';
import { pullCommand, type PullCommandContext } from './pull.js';

export const DEFAULT_HTML_REPORT = 'dashlint-report.html';

/** `https://github.com/owner/repo` and the checked-out commit, for the HTML code links. */
export function repositoryOf(dir: string): HtmlOptions['repository'] {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    const remote = git(['remote', 'get-url', 'origin']);
    const m =
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
        remote,
      );
    if (m === null) return undefined;
    return { url: `https://github.com/${m[1]}/${m[2]}`, ref: git(['rev-parse', 'HEAD']) };
  } catch {
    // Not a git checkout, or no origin: the report names files without links.
    return undefined;
  }
}

export type AuditPull = Pick<PullCommandContext, 'fetch' | 'sleep'>;

export async function auditCommand(
  flags: ParsedArgs['flags'],
  ctx: CommandContext,
  pull: AuditPull = {},
): Promise<number> {
  const format = (flags.format as 'html' | 'json' | 'text' | undefined) ?? 'html';
  const config = readConfig(ctx, 'audit');

  if (flags.offline !== true) {
    const code = await pullCommand(['--config', configFile(ctx)], {
      cwd: ctx.cwd,
      env: ctx.env,
      tool: ctx.tool,
      // Errors always print; progress only without --quiet. The result is the report, not this.
      stdout: (line) => info(ctx, line),
      stderr: (line) => {
        if (!ctx.quiet || line.startsWith('dashlint pull:')) ctx.stderr(line);
      },
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
      ...pull,
    });
    if (code !== 0) return code;
  }

  const all = descriptors();
  const catalogs = configCatalogs(ctx, config, all);
  const requirements = readRequirements(config.requirements);
  const model = checkModel(ctx, {
    mode: 'audit',
    catalogs,
    requirements,
    ignore: config.ignore,
    all,
  });

  const out = flags.out as string | undefined;
  if (format === 'html') {
    const file = resolve(ctx.cwd, out ?? DEFAULT_HTML_REPORT);
    const repository = repositoryOf(config.dir);
    emitReport(ctx, 'audit', model, 'html', file, repository === undefined ? {} : { repository });
    print(ctx, renderText(model, { htmlFile: file }));
  } else emitReport(ctx, 'audit', model, format, out);

  const failOn: FailOn = config.failOn;
  return failsAt(model.report.summary, failOn) ? 1 : 0;
}
