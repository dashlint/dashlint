// The command line (spec 6.9.1): one command, its flags and the global flags, in any order. Every
// mistake is a usage error (exit 2) that names the flag, with a did-you-mean when one is close.
import { cliMessages } from '../report/messages.js';

/** A failure the CLI reports with its exit code (spec 6.9.2). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 3 | 4,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usageError = (message: string): CliError => new CliError(message, 2);

/** Edit distance (insert, delete, replace, swap two neighbours), for did-you-mean. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const up = d[i - 1] as number[];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (up[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (up[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
    }
  return (d[a.length] as number[])[b.length] as number;
}

/** The closest known word, when it is within a third of its length (at least one edit). */
export function didYouMean(word: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const k of known) {
    const distance = editDistance(word.toLowerCase(), k.toLowerCase());
    if (distance < bestDistance) {
      best = k;
      bestDistance = distance;
    }
  }
  if (best === undefined) return undefined;
  return bestDistance <= Math.max(1, Math.floor(best.length / 3)) ? best : undefined;
}

export type FlagKind = 'string' | 'list' | 'boolean';

export interface FlagSpec {
  kind: FlagKind;
  choices?: readonly string[];
}

export const GLOBAL_FLAGS: Readonly<Record<string, FlagSpec>> = {
  config: { kind: 'string' },
  cwd: { kind: 'string' },
  quiet: { kind: 'boolean' },
  'no-color': { kind: 'boolean' },
  version: { kind: 'boolean' },
  help: { kind: 'boolean' },
};

export const FORMATS = ['text', 'json', 'html', 'markdown'] as const;
export type Format = (typeof FORMATS)[number];
export const FAIL_ON = ['dead', 'partly-dead', 'degraded', 'never'] as const;
export type FailOn = (typeof FAIL_ON)[number];

export const COMMANDS: Readonly<Record<string, Readonly<Record<string, FlagSpec>>>> = {
  extract: { source: { kind: 'string' }, out: { kind: 'string' } },
  pull: { out: { kind: 'string' } },
  check: {
    catalog: { kind: 'list' },
    requirements: { kind: 'string' },
    format: { kind: 'string', choices: FORMATS },
    out: { kind: 'string' },
    'fail-on': { kind: 'string', choices: FAIL_ON },
  },
};

export interface Globals {
  config?: string;
  cwd?: string;
  quiet: boolean;
  noColor: boolean;
  version: boolean;
  help: boolean;
}

export interface ParsedArgs {
  command?: string;
  globals: Globals;
  /** The command's flags by name: a string, a list (repeatable flags) or true. */
  flags: Record<string, string | string[] | true>;
}

/**
 * Splits argv into the command, its flags and the global flags. `--flag value` and `--flag=value`
 * both work; a list flag repeats. With `--version` or `--help` nothing else is checked.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.includes('--version') || argv.includes('--help') || argv.includes('-h'))
    return {
      globals: {
        quiet: false,
        noColor: false,
        version: argv.includes('--version'),
        help: !argv.includes('--version'),
      },
      flags: {},
    };

  let command: string | undefined;
  const values: Record<string, string | string[] | true> = {};
  const owner: Record<string, 'global' | 'command'> = {};
  const pending: { name: string; value: string | true }[] = [];
  const named = argv.find((a) => !a.startsWith('--') && Object.hasOwn(COMMANDS, a));
  const flagsOf = (c: string | undefined) =>
    c === undefined ? Object.values(COMMANDS).flatMap(Object.keys) : Object.keys(COMMANDS[c] ?? {});
  const unknownFlag = (name: string) =>
    usageError(
      cliMessages.unknownFlag(
        `--${name}`,
        didYouMean(
          `--${name}`,
          [...Object.keys(GLOBAL_FLAGS), ...flagsOf(command ?? named)].map((f) => `--${f}`),
        ),
      ),
    );

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      if (command !== undefined) throw usageError(cliMessages.positional(arg));
      if (!Object.hasOwn(COMMANDS, arg))
        throw usageError(cliMessages.unknownCommand(arg, didYouMean(arg, Object.keys(COMMANDS))));
      command = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    // Every command flag takes a value; only global flags are switches.
    if (!Object.hasOwn(GLOBAL_FLAGS, name) && !flagsOf(undefined).includes(name))
      throw unknownFlag(name);
    if (GLOBAL_FLAGS[name]?.kind === 'boolean') {
      if (inline !== undefined) throw usageError(cliMessages.flagTakesNoValue(`--${name}`));
      pending.push({ name, value: true });
    } else if (inline === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--'))
        throw usageError(cliMessages.flagNeedsValue(`--${name}`));
      pending.push({ name, value: next });
      i++;
    } else if (inline === '') throw usageError(cliMessages.flagNeedsValue(`--${name}`));
    else pending.push({ name, value: inline });
  }

  const commandFlags = command === undefined ? {} : (COMMANDS[command] ?? {});
  for (const p of pending) {
    const isGlobal = Object.hasOwn(GLOBAL_FLAGS, p.name);
    const spec = isGlobal ? GLOBAL_FLAGS[p.name] : commandFlags[p.name];
    if (spec === undefined) throw unknownFlag(p.name);
    if (typeof p.value === 'string' && spec.choices && !spec.choices.includes(p.value))
      throw usageError(cliMessages.flagChoice(`--${p.name}`, p.value, spec.choices));
    if (spec.kind === 'list') {
      const list = (values[p.name] as string[] | undefined) ?? [];
      list.push(p.value as string);
      values[p.name] = list;
    } else {
      if (Object.hasOwn(values, p.name)) throw usageError(cliMessages.flagTwice(`--${p.name}`));
      values[p.name] = p.value;
    }
    owner[p.name] = isGlobal ? 'global' : 'command';
  }

  const flags: ParsedArgs['flags'] = {};
  for (const [name, value] of Object.entries(values))
    if (owner[name] === 'command') flags[name] = value;
  const str = (name: string) => (typeof values[name] === 'string' ? values[name] : undefined);
  const config = str('config');
  const cwd = str('cwd');
  return {
    ...(command === undefined ? {} : { command }),
    globals: {
      ...(config === undefined ? {} : { config }),
      ...(cwd === undefined ? {} : { cwd }),
      quiet: values.quiet === true,
      noColor: values['no-color'] === true,
      version: false,
      help: false,
    },
    flags,
  };
}
