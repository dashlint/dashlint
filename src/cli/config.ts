// `dashlint.config.yml` (spec 6.8): read with the safe YAML loader, every key checked. An unknown
// key is a usage error naming it with a did-you-mean; `key` must be `env:NAME`, never a literal
// (G12). Paths in the config are relative to the config's folder. Choices the spec leaves open are
// in ADR-051.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseIgnore, type IgnoreEntry } from '../check/ignore.js';
import { formatValidationErrors } from '../formats/validate.js';
import { readYaml, type YamlText } from '../formats/yaml.js';
import { cliMessages, pullMessages } from '../report/messages.js';
import { FAIL_ON, didYouMean, usageError, type FailOn } from './args.js';

export const DEFAULT_CONFIG = 'dashlint.config.yml';
export const DEFAULT_REQUIREMENTS = 'dashlint.requirements.json';

export interface PostHogConfig {
  host: string;
  project: number | string;
  /** As written: `env:NAME`. The key itself is read only by `pull`. */
  key: string;
  observedDays?: number;
  hogql: boolean;
  redact: boolean;
}

export interface SourceEntry {
  name: string;
  /** Relative to the config's folder. */
  path: string;
  platforms: string[];
  tsconfig?: string;
}

export interface Config {
  /** The config file, absolute. */
  file: string;
  /** The config's folder: the repository root extraction runs in. */
  dir: string;
  /** The requirements file, absolute. */
  requirements: string;
  posthog?: PostHogConfig;
  sources: SourceEntry[];
  /** Catalogs from other repos, absolute. */
  catalogs: string[];
  exclude: string[];
  ignore: IgnoreEntry[];
  failOn: FailOn;
  /** The parsed YAML, for `pull`'s own checks. */
  raw: Record<string, unknown>;
}

const TOP = [
  'version',
  'requirements',
  'platforms',
  'sources',
  'catalogs',
  'exclude',
  'ignore',
  'failOn',
];
const PLATFORMS = ['posthog'];
const POSTHOG = ['host', 'project', 'key', 'observedDays', 'hogql', 'redact'];
const SOURCE = ['name', 'path', 'platform', 'tsconfig'];
const CATALOG = ['path'];
const IGNORE = ['tile', 'alert', 'dashboard', 'reason', 'until'];
const PLATFORM_NAME = /^[a-z][a-z0-9-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const pointer = (path: (string | number)[]) =>
  path.length === 0
    ? ''
    : `/${path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
const dotted = (path: (string | number)[]) =>
  path.map((p, i) => (typeof p === 'number' ? `[${String(p)}]` : i === 0 ? p : `.${p}`)).join('');

class Checker {
  constructor(
    private readonly file: string,
    private readonly text: YamlText,
  ) {}

  fail(path: (string | number)[], message: string): never {
    throw usageError(cliMessages.configAt(this.file, this.text.lineOf(pointer(path)), message));
  }

  field(path: (string | number)[], expected: string): never {
    this.fail(path, cliMessages.configField(dotted(path), expected));
  }

  keys(value: Record<string, unknown>, path: (string | number)[], known: readonly string[]): void {
    for (const k of Object.keys(value))
      if (!known.includes(k))
        this.fail(
          [...path, k],
          cliMessages.configUnknownKey(dotted([...path, k]), didYouMean(k, known)),
        );
  }

  mapping(value: unknown, path: (string | number)[]): Record<string, unknown> {
    if (!isRecord(value)) this.field(path, 'a mapping');
    return value;
  }

  list(value: unknown, path: (string | number)[]): unknown[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) this.field(path, 'a list');
    return value;
  }

  str(value: unknown, path: (string | number)[], expected = 'text'): string {
    if (typeof value !== 'string' || value.trim() === '') this.field(path, expected);
    return value;
  }
}

function posthogOf(c: Checker, value: unknown): PostHogConfig {
  const path = ['platforms', 'posthog'];
  const ph = c.mapping(value, path);
  c.keys(ph, path, POSTHOG);
  for (const field of ['host', 'project', 'key'])
    if (ph[field] === undefined || ph[field] === null)
      c.fail([...path, field], cliMessages.configMissing(dotted([...path, field])));
  if (typeof ph.host !== 'string') c.field([...path, 'host'], 'a URL');
  if (typeof ph.project !== 'number' && typeof ph.project !== 'string')
    c.field([...path, 'project'], 'the numeric project id');
  // Spec 6.8: the sentence alone, so it reads the same wherever the key is written wrong.
  if (typeof ph.key !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ph.key))
    throw usageError(pullMessages.literalKey);
  const d = ph.observedDays;
  if (d !== undefined && (typeof d !== 'number' || !Number.isInteger(d) || d < 1))
    c.field([...path, 'observedDays'], 'a whole number of days, at least 1');
  for (const flag of ['hogql', 'redact'])
    if (ph[flag] !== undefined && typeof ph[flag] !== 'boolean')
      c.field([...path, flag], 'true or false');
  return {
    host: ph.host,
    project: ph.project,
    key: ph.key,
    ...(typeof d === 'number' ? { observedDays: d } : {}),
    hogql: ph.hogql === true,
    redact: ph.redact === true,
  };
}

function sourceOf(c: Checker, value: unknown, i: number): SourceEntry {
  const path = ['sources', i];
  const s = c.mapping(value, path);
  c.keys(s, path, SOURCE);
  const name = c.str(s.name, [...path, 'name'], 'a name');
  const sourcePath = c.str(s.path, [...path, 'path'], 'a folder relative to the config');
  const raw = s.platform;
  const platforms = typeof raw === 'string' ? [raw] : raw;
  if (
    !Array.isArray(platforms) ||
    platforms.length === 0 ||
    !platforms.every((p) => typeof p === 'string' && PLATFORM_NAME.test(p))
  )
    c.field([...path, 'platform'], 'a platform name such as web, or a list such as [ios, android]');
  const tsconfig = s.tsconfig;
  if (tsconfig !== undefined)
    c.str(tsconfig, [...path, 'tsconfig'], 'a file relative to the config');
  return {
    name,
    path: sourcePath,
    platforms: [...new Set(platforms as string[])],
    ...(typeof tsconfig === 'string' ? { tsconfig } : {}),
  };
}

/** Checks a parsed config. `file` is absolute; errors name it and the line. */
export function configOf(value: unknown, file: string, text: YamlText): Config {
  const c = new Checker(file, text);
  if (!isRecord(value))
    throw usageError(
      cliMessages.configAt(file, undefined, cliMessages.configField('the config', 'a mapping')),
    );
  c.keys(value, [], TOP);
  if (value.version !== undefined && value.version !== 1) c.field(['version'], '1');

  const requirements = value.requirements ?? DEFAULT_REQUIREMENTS;
  if (typeof requirements !== 'string' || requirements === '')
    c.field(['requirements'], 'a file name');

  let posthog: PostHogConfig | undefined;
  if (value.platforms !== undefined) {
    const platforms = c.mapping(value.platforms, ['platforms']);
    c.keys(platforms, ['platforms'], PLATFORMS);
    if (platforms.posthog !== undefined) posthog = posthogOf(c, platforms.posthog);
  }

  const sources = c.list(value.sources, ['sources']).map((s, i) => sourceOf(c, s, i));
  const seen = new Set<string>();
  sources.forEach((s, i) => {
    if (seen.has(s.name)) c.fail(['sources', i, 'name'], cliMessages.configDuplicateSource(s.name));
    seen.add(s.name);
  });

  const dir = dirname(file);
  const catalogs = c.list(value.catalogs, ['catalogs']).map((entry, i) => {
    const e = c.mapping(entry, ['catalogs', i]);
    c.keys(e, ['catalogs', i], CATALOG);
    return resolve(dir, c.str(e.path, ['catalogs', i, 'path'], 'a file relative to the config'));
  });
  const exclude = c
    .list(value.exclude, ['exclude'])
    .map((g, i) => c.str(g, ['exclude', i], 'a glob'));

  const ignoreList = c.list(value.ignore, ['ignore']);
  ignoreList.forEach((entry, i) => {
    if (isRecord(entry)) c.keys(entry, ['ignore', i], IGNORE);
  });
  const ignore = parseIgnore(ignoreList);
  if (!ignore.ok)
    throw usageError(ignore.errors.map((e) => cliMessages.configAt(file, undefined, e)).join('\n'));

  const failOn = value.failOn ?? 'dead';
  if (typeof failOn !== 'string' || !(FAIL_ON as readonly string[]).includes(failOn))
    c.field(['failOn'], `one of ${FAIL_ON.join(', ')}`);

  return {
    file,
    dir,
    requirements: resolve(dir, requirements as string),
    ...(posthog === undefined ? {} : { posthog }),
    sources,
    catalogs,
    exclude,
    ignore: ignore.value,
    failOn: failOn as FailOn,
    raw: value,
  };
}

/** Reads and checks the config file (absolute). A missing or unreadable file is exit 2. */
export function loadConfig(file: string): Config {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    throw usageError(
      cliMessages.configUnreadable(file, e instanceof Error ? e.message : String(e)),
    );
  }
  const parsed = readYaml(source);
  if (!parsed.ok)
    throw usageError(
      formatValidationErrors(parsed.errors)
        .map((err) => cliMessages.configAt(file, undefined, err))
        .join('\n'),
    );
  return configOf(parsed.text.value, file, parsed.text);
}
