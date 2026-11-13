// `dashlint extract [--source <name>] [--out <file>]` (spec 6.9.1): each source's catalog, no
// network. With no --out each catalog is written next to the config as `<name>.catalog.json`;
// `--out -` prints the one catalog (ADR-051).
import { resolve } from 'node:path';
import { writeCatalog } from '../../extract/catalog.js';
import { cliMessages } from '../../report/messages.js';
import { didYouMean, usageError, type ParsedArgs } from '../args.js';
import {
  descriptors,
  extractSource,
  info,
  print,
  readConfig,
  writeText,
  type CommandContext,
} from './common.js';

export function extractCommand(flags: ParsedArgs['flags'], ctx: CommandContext): number {
  const config = readConfig(ctx, 'extract');
  const only = flags.source as string | undefined;
  const sources =
    only === undefined ? config.sources : config.sources.filter((s) => s.name === only);
  if (only !== undefined && sources.length === 0)
    throw usageError(
      cliMessages.unknownSource(
        only,
        didYouMean(
          only,
          config.sources.map((s) => s.name),
        ),
      ),
    );
  if (sources.length === 0) throw usageError(cliMessages.noSources);
  const out = flags.out as string | undefined;
  if (out !== undefined && sources.length > 1) throw usageError(cliMessages.outNeedsOneCatalog);

  const all = descriptors();
  for (const source of sources) {
    const catalog = extractSource(ctx, config, source, all);
    const json = writeCatalog(catalog);
    if (out === '-') {
      print(ctx, json);
      continue;
    }
    const file =
      out === undefined
        ? resolve(config.dir, `${source.name}.catalog.json`)
        : resolve(ctx.cwd, out);
    writeText(file, json);
    info(
      ctx,
      cliMessages.wroteCatalog(
        file,
        source.name,
        Object.keys(catalog.events).length,
        catalog.coverage.nameResolutionRate,
      ),
    );
  }
  return 0;
}
