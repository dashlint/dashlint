// `dashlint init [--yes]` (spec 6.9.1): finds the apps that depend on an SDK dashlint describes and
// writes a commented `dashlint.config.yml`. An existing config is never replaced without --yes.
// The PostHog block is written commented out: the project id is not in the code (ADR-052).
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { globSync } from 'tinyglobby';
import type { Descriptor } from '../../descriptors/index.js';
import { readYaml } from '../../formats/yaml.js';
import { cliMessages } from '../../report/messages.js';
import { usageError, type ParsedArgs } from '../args.js';
import { DEFAULT_REQUIREMENTS } from '../config.js';
import { configFile, descriptors, info, writeText, type CommandContext } from './common.js';

export interface DetectedSource {
  name: string;
  /** Relative to the config's folder with / separators; `.` for the folder itself. */
  path: string;
  platforms: string[];
  /** The SDK packages the app depends on, in descriptor order. */
  packages: string[];
}

export interface Detection {
  /** True when the root package.json or pnpm-workspace.yaml lists workspaces. */
  workspaces: boolean;
  sources: DetectedSource[];
  /** package.json files that could not be read, relative to the root. */
  skipped: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '') : [];

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The workspace patterns of npm, yarn and pnpm; none means a single app. */
function workspacePatterns(root: string, pkg: Record<string, unknown> | undefined): string[] {
  const ws = pkg?.workspaces;
  const patterns = isRecord(ws) ? strings(ws.packages) : strings(ws);
  const pnpm = `${root}/pnpm-workspace.yaml`;
  if (existsSync(pnpm)) {
    const parsed = readYaml(readFileSync(pnpm, 'utf8'));
    if (parsed.ok && isRecord(parsed.text.value))
      patterns.push(...strings(parsed.text.value.packages));
  }
  return patterns;
}

/** `apps/web` gives `web`; a scoped package name at the root gives its last part. */
function sourceName(path: string, pkg: Record<string, unknown> | undefined): string {
  const fromPackage = typeof pkg?.name === 'string' ? pkg.name.split('/').pop() : undefined;
  const raw = path === '.' ? (fromPackage ?? '') : basename(path);
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name === '' ? 'app' : name;
}

/** Finds each app (the root, or every workspace) that depends on a described SDK package. */
export function detectSources(root: string, all: readonly Descriptor[]): Detection {
  const rootPkg = readJson(`${root}/package.json`);
  const patterns = workspacePatterns(root, rootPkg);
  const skipped: string[] = [];
  let folders: string[];
  if (patterns.length === 0) {
    if (existsSync(`${root}/package.json`) && rootPkg === undefined) skipped.push('package.json');
    folders = ['.'];
  } else {
    const trim = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');
    folders = globSync(
      patterns.filter((p) => !p.startsWith('!')).map((p) => `${trim(p)}/package.json`),
      {
        cwd: root,
        ignore: [
          '**/node_modules/**',
          ...patterns
            .filter((p) => p.startsWith('!'))
            .map((p) => `${trim(p.slice(1))}/package.json`),
        ],
      },
    )
      .map((f) => dirname(f).split('\\').join('/'))
      .sort();
  }

  const sources: DetectedSource[] = [];
  const taken = new Set<string>();
  for (const folder of folders) {
    const file = folder === '.' ? 'package.json' : `${folder}/package.json`;
    const pkg = folder === '.' ? rootPkg : readJson(`${root}/${file}`);
    if (pkg === undefined) {
      if (folder !== '.') skipped.push(file);
      continue;
    }
    const deps = new Set(
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
        (k) => (isRecord(pkg[k]) ? Object.keys(pkg[k]) : []),
      ),
    );
    const found = all.filter((d) => deps.has(d.package));
    if (found.length === 0) continue;
    const base = sourceName(folder, pkg);
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${String(i)}`;
    taken.add(name);
    sources.push({
      name,
      path: folder,
      platforms: [...new Set(found.flatMap((d) => d.platforms))],
      packages: found.map((d) => d.package),
    });
  }
  return { workspaces: patterns.length > 0, sources, skipped };
}

/** A YAML scalar: plain when it is safe, otherwise double quoted (JSON is valid YAML there). */
const scalar = (s: string): string => (/^[A-Za-z0-9_./@-]+$/.test(s) ? s : JSON.stringify(s));

/** The config text: every key of spec 6.8 present or shown in a comment. */
export function configText(detection: Detection, all: readonly Descriptor[]): string {
  const packages = all.map((d) => d.package).join(', ');
  const lines = [
    '# dashlint config, written by dashlint init. Paths are relative to this file.',
    'version: 1',
    `requirements: ${DEFAULT_REQUIREMENTS}`,
    '',
    '# PostHog: uncomment, set your project id, then run dashlint pull. The key is a personal API',
    '# key with read-only scopes, read from the environment variable named here, never written here.',
    '# platforms:',
    '#   posthog:',
    '#     host: https://us.posthog.com   # or https://eu.posthog.com, or your own URL',
    '#     project: 12345',
    '#     key: env:DASHLINT_POSTHOG_KEY',
    '#     observedDays: 30',
    '',
  ];
  if (detection.sources.length === 0)
    lines.push(
      `# No app here depends on ${packages}. Add one source per app that sends`,
      '# events, for example:',
      '#   - name: web',
      '#     path: web',
      '#     platform: web',
      'sources: []',
    );
  else {
    lines.push('# One source per app that sends events. tsconfig: <file> is optional.', 'sources:');
    for (const s of detection.sources) {
      const platform =
        s.platforms.length === 1 ? (s.platforms[0] as string) : `[${s.platforms.join(', ')}]`;
      lines.push(
        `  # ${s.packages.join(', ')} in ${s.path === '.' ? '' : `${s.path}/`}package.json`,
        `  - name: ${scalar(s.name)}`,
        `    path: ${scalar(s.path)}`,
        `    platform: ${platform}`,
      );
    }
  }
  lines.push(
    '',
    '# Catalogs from other repos, for example: - path: catalogs/server.json',
    'catalogs: []',
    '# Globs to leave out, added to the defaults.',
    'exclude: []',
    '# Tiles or alerts left out on purpose, for example:',
    '#   - tile: insight:Ab12Cd34',
    '#     reason: retired on purpose',
    '#     until: 2027-06-30',
    'ignore: []',
    '# What fails the run: dead, partly-dead, degraded or never.',
    'failOn: dead',
    '',
  );
  return lines.join('\n');
}

export function initCommand(flags: ParsedArgs['flags'], ctx: CommandContext): number {
  const file = configFile(ctx);
  if (existsSync(file) && flags.yes !== true) throw usageError(cliMessages.configExists(file));
  const all = descriptors();
  const root = dirname(file);
  const detection = detectSources(root, all);
  for (const s of detection.skipped)
    info(ctx, cliMessages.warning('init', cliMessages.packageJsonUnreadable(s)));
  writeText(file, configText(detection, all));
  info(
    ctx,
    cliMessages.wroteConfig(
      file,
      detection.sources.map((s) => `${s.name} (${s.path}, ${s.platforms.join(', ')})`),
    ),
  );
  return 0;
}
