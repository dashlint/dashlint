#!/usr/bin/env node
// The `dashlint` binary (spec 6.9.1, 6.9.2): global flags, one command, exit codes 0 to 4. Every
// usage or config mistake is exit 2; anything unexpected is exit 3 with the bug sentence.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliMessages } from '../report/messages.js';
import { COMMANDS, CliError, parseArgs, usageError, type ParsedArgs } from './args.js';
import { checkCommand } from './commands/check.js';
import type { CommandContext } from './commands/common.js';
import { extractCommand } from './commands/extract.js';
import { initCommand } from './commands/init.js';
import { pullCommand, type PullCommandContext } from './commands/pull.js';

export function readVersion(): string {
  const packageJsonUrl = new URL('../../package.json', import.meta.url);
  const packageJsonPath = fileURLToPath(packageJsonUrl);
  const contents = readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(contents) as { version: string };
  return parsed.version;
}

export const helpText = (): string => cliMessages.help(readVersion());

export type MainContext = Omit<CommandContext, 'config' | 'quiet' | 'tool'> &
  Pick<PullCommandContext, 'fetch' | 'sleep'> & { tool?: string };

/** `pull` keeps its own flag parsing; it gets its flags back as arguments. */
function pullArgs(parsed: ParsedArgs): string[] {
  const out = parsed.flags.out;
  return [
    ...(parsed.globals.config === undefined ? [] : ['--config', parsed.globals.config]),
    ...(typeof out === 'string' ? ['--out', out] : []),
  ];
}

/** Runs one command line; returns the exit code. Output goes through `ctx` only. */
export async function run(argv: readonly string[], ctx: MainContext): Promise<number> {
  // Named before parsing, so a mistake in its flags is reported under it.
  let command = argv.find((a) => !a.startsWith('--') && Object.hasOwn(COMMANDS, a));
  try {
    const parsed = parseArgs(argv);
    command = parsed.command;
    const tool = ctx.tool ?? readVersion();
    if (parsed.globals.version) {
      ctx.stdout(tool);
      return 0;
    }
    if (parsed.globals.help) {
      ctx.stdout(cliMessages.help(tool));
      return 0;
    }
    if (command === undefined) throw usageError(cliMessages.noCommand);
    const cwd = resolve(ctx.cwd, parsed.globals.cwd ?? '.');
    const quiet = parsed.globals.quiet;
    if (command === 'pull')
      return await pullCommand(pullArgs(parsed), {
        ...ctx,
        cwd,
        tool,
        stderr: (line) => {
          // Errors always print; progress and the public-names notice only without --quiet.
          if (!quiet || line.startsWith('dashlint pull:')) ctx.stderr(line);
        },
      });
    const commandCtx: CommandContext = {
      cwd,
      env: ctx.env,
      tool,
      quiet,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
      ...(parsed.globals.config === undefined ? {} : { config: parsed.globals.config }),
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    };
    if (command === 'init') return initCommand(parsed.flags, commandCtx);
    return command === 'extract'
      ? extractCommand(parsed.flags, commandCtx)
      : checkCommand(parsed.flags, commandCtx);
  } catch (e) {
    if (e instanceof CliError && e.exitCode !== 3) {
      ctx.stderr(cliMessages.prefix(command, e.message));
      return e.exitCode;
    }
    ctx.stderr(cliMessages.bug(command, e instanceof Error ? e.message : String(e)));
    return 3;
  }
}

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
