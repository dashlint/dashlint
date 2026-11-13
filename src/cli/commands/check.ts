// `dashlint check [--catalog <file>]... [--requirements <file>] [--format ...] [--out <file>]
// [--fail-on <level>]` (spec 6.9.1): extract (unless catalogs are given) and check, no network.
// Exit 1 when a tile is at or above failOn (6.9.2); alerts are reported, never failed on (ADR-051).
import { resolve } from 'node:path';
import { applyIgnore, checkAlerts, checkContext, checkTiles } from '../../check/index.js';
import { builtinTables } from '../../extract/merge.js';
import type { Catalog } from '../../formats/catalog.js';
import type { ReportSummary } from '../../formats/report.js';
import { buildReport } from '../../report/build.js';
import { renderHtml } from '../../report/html.js';
import { renderJson } from '../../report/json.js';
import { cliMessages } from '../../report/messages.js';
import { renderText } from '../../report/text.js';
import { usageError, type FailOn, type Format, type ParsedArgs } from '../args.js';
import {
  descriptors,
  extractSource,
  info,
  print,
  readCatalog,
  readConfig,
  readConfigIfAny,
  readRequirements,
  writeText,
  type CommandContext,
} from './common.js';

/** True when the summary has a tile at or above `failOn`. */
export function failsAt(summary: ReportSummary, failOn: FailOn): boolean {
  switch (failOn) {
    case 'never':
      return false;
    case 'dead':
      return summary.dead > 0;
    case 'partly-dead':
      return summary.dead + summary.partlyDead > 0;
    case 'degraded':
      return summary.dead + summary.partlyDead + summary.degraded > 0;
  }
}

export function checkCommand(flags: ParsedArgs['flags'], ctx: CommandContext): number {
  const format = (flags.format as Format | undefined) ?? 'text';
  if (format === 'markdown') throw usageError(cliMessages.markdownNeedsDiff);
  const given = ((flags.catalog as string[] | undefined) ?? []).map((f) => resolve(ctx.cwd, f));
  const requirementsFlag = flags.requirements as string | undefined;
  // Catalogs and requirements on the command line need no config; anything else does.
  const config =
    given.length > 0 && requirementsFlag !== undefined
      ? readConfigIfAny(ctx)
      : readConfig(ctx, 'check');

  const all = descriptors();
  const catalogs: Catalog[] = given.map(readCatalog);
  if (given.length === 0 && config !== undefined) {
    if (config.sources.length === 0 && config.catalogs.length === 0)
      throw usageError(cliMessages.noSources);
    for (const source of config.sources) catalogs.push(extractSource(ctx, config, source, all));
  }
  for (const file of config?.catalogs ?? []) catalogs.push(readCatalog(file));

  const requirements = readRequirements(
    requirementsFlag === undefined
      ? (config?.requirements as string)
      : resolve(ctx.cwd, requirementsFlag),
  );

  const checks = checkContext(catalogs, requirements, builtinTables(all));
  const now = new Date(ctx.now?.() ?? Date.now());
  const outcome = applyIgnore(
    requirements,
    checkTiles(checks, requirements),
    checkAlerts(checks, requirements),
    config?.ignore ?? [],
    now,
  );
  const model = buildReport({
    tool: ctx.tool,
    mode: 'check',
    requirements,
    catalogs,
    ctx: checks,
    outcome,
  });

  const out = flags.out as string | undefined;
  const text =
    format === 'json'
      ? renderJson(model)
      : format === 'html'
        ? renderHtml(model)
        : renderText(model);
  if (out === undefined) print(ctx, text);
  else {
    const file = resolve(ctx.cwd, out);
    writeText(file, text);
    info(ctx, cliMessages.wroteReport(file));
  }

  const failOn = (flags['fail-on'] as FailOn | undefined) ?? config?.failOn ?? 'dead';
  return failsAt(model.report.summary, failOn) ? 1 : 0;
}
