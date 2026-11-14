// `dashlint check [--catalog <file>]... [--requirements <file>] [--format ...] [--out <file>]
// [--fail-on <level>]` (spec 6.9.1): extract (unless catalogs are given) and check, no network.
// Exit 1 when a tile is at or above failOn (6.9.2); alerts are reported, never failed on (ADR-051).
import { resolve } from 'node:path';
import {
  applyIgnore,
  checkAlerts,
  checkContext,
  checkTiles,
  type IgnoreEntry,
} from '../../check/index.js';
import type { Descriptor } from '../../descriptors/index.js';
import { builtinTables } from '../../extract/merge.js';
import type { Catalog } from '../../formats/catalog.js';
import type { ReportMode, ReportSummary } from '../../formats/report.js';
import type { Requirements } from '../../formats/requirements.js';
import { buildReport, type ReportModel } from '../../report/build.js';
import { renderHtml, type HtmlOptions } from '../../report/html.js';
import { renderJson } from '../../report/json.js';
import { cliMessages } from '../../report/messages.js';
import { renderText } from '../../report/text.js';
import { usageError, type FailOn, type Format, type ParsedArgs } from '../args.js';
import type { Config } from '../config.js';
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

/** Every configured source extracted, then the config's catalog files; none at all is exit 2. */
export function configCatalogs(ctx: CommandContext, config: Config, all: Descriptor[]): Catalog[] {
  if (config.sources.length === 0 && config.catalogs.length === 0)
    throw usageError(cliMessages.noSources);
  return [
    ...config.sources.map((source) => extractSource(ctx, config, source, all)),
    ...config.catalogs.map(readCatalog),
  ];
}

/** The catalogs checked against the requirements, the ignore list applied: the report model. */
export function checkModel(
  ctx: CommandContext,
  input: {
    mode: ReportMode;
    catalogs: readonly Catalog[];
    requirements: Requirements;
    ignore: readonly IgnoreEntry[];
    all: Descriptor[];
    /**
     * A diff's base catalogs: sightings of what the change removes are not "produced elsewhere"
     * in the head's report, as in the diff's own verdicts (ADR-060).
     */
    base?: readonly Catalog[];
  },
): ReportModel {
  const { catalogs, requirements } = input;
  const tables = builtinTables(input.all);
  const head = checkContext(catalogs, requirements, tables);
  const checks =
    input.base === undefined
      ? head
      : {
          ...head,
          facts: {
            ...head.facts,
            removedBy: checkContext(input.base, requirements, tables).facts.code,
          },
        };
  const now = new Date(ctx.now?.() ?? Date.now());
  const outcome = applyIgnore(
    requirements,
    checkTiles(checks, requirements),
    checkAlerts(checks, requirements),
    input.ignore,
    now,
  );
  return buildReport({
    tool: ctx.tool,
    mode: input.mode,
    requirements,
    catalogs,
    ctx: checks,
    outcome,
  });
}

/** The report in `format`, printed or written to `out` (relative to the working directory). */
export function emitReport(
  ctx: CommandContext,
  command: string,
  model: ReportModel,
  format: Exclude<Format, 'markdown'>,
  out: string | undefined,
  html: HtmlOptions = {},
): void {
  const text =
    format === 'json'
      ? renderJson(model)
      : format === 'html'
        ? renderHtml(model, html)
        : renderText(model);
  if (out === undefined) print(ctx, text);
  else {
    const file = resolve(ctx.cwd, out);
    writeText(file, text);
    info(ctx, cliMessages.wroteReport(command, file));
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
  const catalogs: Catalog[] =
    given.length === 0 && config !== undefined
      ? configCatalogs(ctx, config, all)
      : [...given.map(readCatalog), ...(config?.catalogs ?? []).map(readCatalog)];

  const requirements = readRequirements(
    requirementsFlag === undefined
      ? (config?.requirements as string)
      : resolve(ctx.cwd, requirementsFlag),
  );

  const model = checkModel(ctx, {
    mode: 'check',
    catalogs,
    requirements,
    ignore: config?.ignore ?? [],
    all,
  });
  emitReport(ctx, 'check', model, format, flags.out as string | undefined);

  const failOn = (flags['fail-on'] as FailOn | undefined) ?? config?.failOn ?? 'dead';
  return failsAt(model.report.summary, failOn) ? 1 : 0;
}
