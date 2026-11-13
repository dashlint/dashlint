// `dashlint pull [--config <file>]` (spec 6.5, 6.8, 6.13): reads `platforms.posthog` and
// `requirements` from the config, pulls, and writes the requirements file next to the config. The
// full config loader (unknown keys, did-you-mean, every section) is T7.4's; this reads only what
// `pull` needs and refuses anything it cannot honour (ADR-035).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { PullError, resolveKey } from '../../adapters/posthog/client.js';
import {
  pullRequirements,
  requirementsJson,
  type PullOptions,
} from '../../adapters/posthog/pull.js';
import { formatValidationErrors } from '../../formats/validate.js';
import { readYaml } from '../../formats/yaml.js';
import { pullMessages } from '../../report/messages.js';

export const DEFAULT_CONFIG = 'dashlint.config.yml';
export const DEFAULT_REQUIREMENTS = 'dashlint.requirements.json';

export interface PullCommandContext {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  tool: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now?: () => number;
  fetch?: PullOptions['fetch'];
  sleep?: PullOptions['sleep'];
}

interface PullConfig {
  settings: Omit<PullOptions, 'tool'>;
  /** The requirements file, absolute. */
  out: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function usage(message: string): PullError {
  return new PullError(message, 2);
}

/** `--config <file>` and nothing else. */
export function parsePullArgs(args: readonly string[]): { config: string } {
  let config = DEFAULT_CONFIG;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--config') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw usage(`${pullMessages.flagNeedsValue(arg)}\n${pullMessages.usage}`);
      config = value;
      i++;
    } else if (arg.startsWith('--config=') && arg.length > '--config='.length) {
      config = arg.slice('--config='.length);
    } else throw usage(`${pullMessages.unknownFlag(arg)}\n${pullMessages.usage}`);
  }
  return { config };
}

/** The parts of a parsed config `pull` uses, checked; the key is read from the environment. */
export function pullConfigOf(
  value: unknown,
  configFile: string,
  env: PullCommandContext['env'],
): PullConfig {
  if (!isRecord(value)) throw usage(pullMessages.configField('the config', 'a mapping'));
  const platforms = value.platforms;
  if (platforms === undefined) throw usage(pullMessages.configMissing('platforms.posthog'));
  if (!isRecord(platforms)) throw usage(pullMessages.configField('platforms', 'a mapping'));
  const ph = platforms.posthog;
  if (ph === undefined) throw usage(pullMessages.configMissing('platforms.posthog'));
  if (!isRecord(ph)) throw usage(pullMessages.configField('platforms.posthog', 'a mapping'));

  for (const field of ['host', 'project', 'key'])
    if (ph[field] === undefined || ph[field] === null)
      throw usage(pullMessages.configMissing(`platforms.posthog.${field}`));
  if (typeof ph.host !== 'string')
    throw usage(pullMessages.configField('platforms.posthog.host', 'a URL'));
  if (typeof ph.project !== 'number' && typeof ph.project !== 'string')
    throw usage(pullMessages.configField('platforms.posthog.project', 'the numeric project id'));
  if (typeof ph.key !== 'string') throw usage(pullMessages.literalKey);
  if (ph.observedDays !== undefined) {
    const d = ph.observedDays;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1)
      throw usage(
        pullMessages.configField(
          'platforms.posthog.observedDays',
          'a whole number of days, at least 1',
        ),
      );
  }
  for (const flag of ['hogql', 'redact'])
    if (ph[flag] !== undefined && typeof ph[flag] !== 'boolean')
      throw usage(pullMessages.configField(`platforms.posthog.${flag}`, 'true or false'));

  const requirements = value.requirements ?? DEFAULT_REQUIREMENTS;
  if (typeof requirements !== 'string' || requirements === '')
    throw usage(pullMessages.configField('requirements', 'a file name'));
  if (extname(requirements).toLowerCase() !== '.json')
    throw usage(pullMessages.requirementsNotJson(requirements));

  // The key last: a config that is wrong in another way says so without needing the key set.
  const key = resolveKey(ph.key, env);
  return {
    settings: {
      host: ph.host,
      project: ph.project,
      key,
      ...(typeof ph.observedDays === 'number' ? { observedDays: ph.observedDays } : {}),
      redact: ph.redact === true,
      hogql: ph.hogql === true,
    },
    out: resolve(dirname(configFile), requirements),
  };
}

function readConfig(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw usage(pullMessages.configUnreadable(file, e instanceof Error ? e.message : String(e)));
  }
  const parsed = readYaml(text);
  if (!parsed.ok)
    throw usage(
      formatValidationErrors(parsed.errors)
        .map((err) => pullMessages.configInvalid(file, err))
        .join('\n'),
    );
  return parsed.text.value;
}

/** Runs `pull`; returns the exit code (0 written, 2 usage or config, 3 a bug, 4 pull failed). */
export async function pullCommand(
  args: readonly string[],
  ctx: PullCommandContext,
): Promise<number> {
  try {
    const { config } = parsePullArgs(args);
    const configFile = resolve(ctx.cwd, config);
    const { settings, out } = pullConfigOf(readConfig(configFile), configFile, ctx.env);
    const requirements = await pullRequirements({
      ...settings,
      tool: ctx.tool,
      info: ctx.stderr,
      ...(ctx.now ? { now: ctx.now } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    });
    const json = requirementsJson(requirements);
    try {
      writeFileSync(out, json);
    } catch (e) {
      throw new PullError(
        pullMessages.cannotWrite(out, e instanceof Error ? e.message : String(e)),
        4,
      );
    }
    ctx.stdout(
      pullMessages.wrote(
        out,
        requirements.tiles.length,
        requirements.dashboards?.length ?? 0,
        requirements.alerts?.length ?? 0,
      ),
    );
    ctx.stderr(settings.redact === true ? pullMessages.redacted : pullMessages.publicNames);
    return 0;
  } catch (e) {
    if (e instanceof PullError) {
      ctx.stderr(pullMessages.failed(e.message));
      return e.exitCode;
    }
    ctx.stderr(pullMessages.bug(e instanceof Error ? e.message : String(e)));
    return 3;
  }
}
