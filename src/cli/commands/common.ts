// What every command shares: its context, the config it reads, the descriptors, files in and out.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  loadDescriptors,
  formatDescriptorErrors,
  type Descriptor,
} from '../../descriptors/index.js';
import { extractCatalog } from '../../extract/catalog.js';
import type { Catalog } from '../../formats/catalog.js';
import type { Requirements } from '../../formats/requirements.js';
import { formatValidationErrors, validateCatalog } from '../../formats/validate.js';
import { loadRequirements } from '../../formats/yaml.js';
import { cliMessages } from '../../report/messages.js';
import { CliError, usageError } from '../args.js';
import { DEFAULT_CONFIG, loadConfig, type Config, type SourceEntry } from '../config.js';

export interface CommandContext {
  /** The working directory, absolute (`--cwd` already applied). */
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The dashlint version. */
  tool: string;
  /** `--config` as given, if it was. */
  config?: string;
  quiet: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now?: () => number;
}

/** Progress and warnings on stderr; `--quiet` drops them, never errors. */
export const info = (ctx: CommandContext, line: string): void => {
  if (!ctx.quiet) ctx.stderr(line);
};

export function configFile(ctx: CommandContext): string {
  return resolve(ctx.cwd, ctx.config ?? DEFAULT_CONFIG);
}

/** The config, or undefined when none was named and the default file is absent. */
export function readConfigIfAny(ctx: CommandContext): Config | undefined {
  const file = configFile(ctx);
  return ctx.config === undefined && !existsSync(file) ? undefined : loadConfig(file);
}

/** The config; without one the command cannot run (exit 2). */
export function readConfig(ctx: CommandContext, command: string): Config {
  const config = readConfigIfAny(ctx);
  if (config === undefined) throw usageError(cliMessages.noConfig(configFile(ctx), command));
  return config;
}

/** The descriptors shipped in the package; an invalid one is a bug (exit 3). */
export function descriptors(): Descriptor[] {
  const r = loadDescriptors();
  if (!r.ok)
    throw new Error(cliMessages.descriptorsInvalid(formatDescriptorErrors(r.errors).join('; ')));
  return r.value;
}

/** Extracts one source of the config; a failure outside any one file is exit 3. */
export function extractSource(
  ctx: CommandContext,
  config: Config,
  source: SourceEntry,
  all: Descriptor[],
): Catalog {
  // A source the config names wrong is the config's mistake (exit 2), not a failed extraction.
  const dir = resolve(config.dir, source.path);
  const inside = relative(config.dir, dir);
  if (
    inside.startsWith('..') ||
    isAbsolute(inside) ||
    !existsSync(dir) ||
    !statSync(dir).isDirectory()
  )
    throw usageError(cliMessages.sourcePathMissing(source.name, source.path, config.dir));
  if (source.tsconfig !== undefined && !existsSync(resolve(config.dir, source.tsconfig)))
    throw usageError(cliMessages.sourceTsconfigMissing(source.name, source.tsconfig));
  const r = extractCatalog({
    repoRoot: config.dir,
    source: {
      name: source.name,
      path: source.path,
      ...(source.tsconfig === undefined ? {} : { tsconfig: source.tsconfig }),
    },
    exclude: config.exclude,
    descriptors: all,
    tool: ctx.tool,
    platforms: source.platforms,
  });
  if (!r.ok) throw new CliError(cliMessages.extractFailed(r.error), 3);
  for (const w of r.value.warnings) info(ctx, cliMessages.warning('extract', w));
  return r.value.catalog;
}

function readText(what: string, file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw usageError(
      cliMessages.fileUnreadable(what, file, e instanceof Error ? e.message : String(e)),
    );
  }
}

/** A catalog file, validated (exit 2 when it is not one). */
export function readCatalog(file: string): Catalog {
  const text = readText('catalog', file);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw usageError(cliMessages.fileInvalid(file, e instanceof Error ? e.message : String(e)));
  }
  const v = validateCatalog(data);
  if (!v.ok)
    throw usageError(
      formatValidationErrors(v.errors)
        .map((e) => cliMessages.fileInvalid(file, e))
        .join('\n'),
    );
  return v.value;
}

/** A requirements file (JSON, or hand-written YAML), validated. */
export function readRequirements(file: string): Requirements {
  if (!existsSync(file)) throw usageError(cliMessages.noRequirements(file));
  const r = loadRequirements(readText('requirements', file));
  if (!r.ok)
    throw usageError(
      formatValidationErrors(r.errors)
        .map((e) => cliMessages.fileInvalid(file, e))
        .join('\n'),
    );
  return r.value;
}

/** Writes `text` to `file`; a failure is exit 2 naming the file. */
export function writeText(file: string, text: string): void {
  try {
    writeFileSync(file, text);
  } catch (e) {
    throw usageError(cliMessages.cannotWrite(file, e instanceof Error ? e.message : String(e)));
  }
}

/** Prints text that ends in a newline, line by line. */
export function print(ctx: CommandContext, text: string): void {
  ctx.stdout(text.endsWith('\n') ? text.slice(0, -1) : text);
}
