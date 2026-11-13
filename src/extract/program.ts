// One TypeScript Program per configured source (spec 6.4 items 1 and 2, T3.2): which files the
// extractor reads, which it skips and counts, and where each SDK's types come from (D2). The
// program never loads compiler plugins and never runs user code; the only process it starts is
// `git check-ignore`, with the file system monitor turned off.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { globSync } from 'tinyglobby';
import ts from 'typescript';
import type { Descriptor } from '../descriptors/model.js';
import type { CatalogSdk, Coverage } from '../formats/catalog.js';

/** D7: tests, stories and mocks are excluded by default (counted). */
export const TEST_PATTERNS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/*.stories.*',
  '**/__mocks__/**',
];

/** Build outputs (spec 6.4 item 1). */
export const BUILD_OUTPUTS = ['dist', 'build', '.next', '.expo'];

/** Files larger than this are skipped and counted. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Why a file of the source is not analysed, in the order the rules apply. */
export type SkipReason =
  'build-output' | 'git-ignored' | 'test-or-story' | 'config-exclude' | 'oversize';

const SKIP_REASONS: SkipReason[] = [
  'build-output',
  'git-ignored',
  'test-or-story',
  'config-exclude',
  'oversize',
];

export interface SourceConfig {
  name: string;
  /** Relative to the repository root. */
  path: string;
  /** Relative to the repository root; otherwise the nearest tsconfig.json inside the repository. */
  tsconfig?: string;
}

export interface ProgramInput {
  repoRoot: string;
  source: SourceConfig;
  /** Config `exclude`: globs relative to the repository root, added to the D7 defaults. */
  exclude?: string[];
  descriptors: Descriptor[];
}

export interface SdkTypes {
  descriptor: Descriptor;
  sdk: CatalogSdk;
  /** The stub added to the program (absolute), or null when the installed types are used. */
  stub: string | null;
}

export interface SourceProgram {
  program: ts.Program;
  /** "." for the repository root, otherwise relative with `/` separators. */
  root: string;
  /** The tsconfig whose options the program uses, relative to the repository root. */
  tsconfig: string | null;
  /** Absolute paths of the files to analyse, sorted. */
  files: string[];
  /** Relative paths of the skipped files, sorted, by reason. */
  skipped: Record<SkipReason, string[]>;
  /** Files that could not be read (relative): unknown, never analysed. */
  unreadable: string[];
  /** The SDKs the source imports, sorted by id. */
  sdks: SdkTypes[];
  /** Non-fatal tsconfig problems; the program uses what could be read. */
  warnings: string[];
  coverage: Pick<Coverage, 'files' | 'excludedFiles' | 'oversizeFiles'>;
}

export type ProgramResult = { ok: true; value: SourceProgram } | { ok: false; error: string };

const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const DECLARATION_FILE = /\.d\.(?:[^/]*\.)?[cm]?ts$/;
const TYPED_EXTENSIONS = new Set<string>([
  ts.Extension.Ts,
  ts.Extension.Tsx,
  ts.Extension.Dts,
  ts.Extension.Mts,
  ts.Extension.Dmts,
  ts.Extension.Cts,
  ts.Extension.Dcts,
]);

/** Used when the source has no tsconfig. */
const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
};

function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

function isInside(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function message(d: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(d.messageText, '\n');
}

interface ParsedConfig {
  file: string;
  options: ts.CompilerOptions;
  fileNames: string[];
  references: string[];
}

// allowJs is passed before the file names are computed, so the config's include picks up `.js`.
function parseConfig(file: string, warnings: string[]): ParsedConfig | string {
  let fatal: string | undefined;
  const host: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      fatal = message(d);
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(file, { allowJs: true }, host);
  if (!parsed) return fatal ?? `cannot read ${file}`;
  // 18003: no inputs found, which a solution-style config with references is meant to have.
  for (const d of parsed.errors) if (d.code !== 18003) warnings.push(message(d));
  return {
    file,
    options: parsed.options,
    fileNames: parsed.fileNames.map(slash),
    references: (parsed.projectReferences ?? []).map((r) => ts.resolveProjectReferencePath(r)),
  };
}

function nearestConfig(sourceDir: string, repoRoot: string): string | undefined {
  for (let dir = sourceDir; isInside(dir, repoRoot); dir = dirname(dir)) {
    const file = join(dir, 'tsconfig.json');
    if (existsSync(file)) return file;
    if (dir === dirname(dir)) break;
  }
  return undefined;
}

interface Candidates {
  config: string | null;
  options: ts.CompilerOptions;
  files: string[];
}

// The config's own files, or for a solution-style config (no files, only references) the files of
// the configs it references, with the options of the one that holds most of the source's files.
function candidates(
  sourceDir: string,
  configFile: string | undefined,
  explicit: boolean,
  warnings: string[],
): Candidates | string {
  const glob = (): string[] =>
    globSync(['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'], {
      cwd: sourceDir,
      absolute: true,
      ignore: ['**/node_modules/**'],
    }).map(slash);
  if (!configFile) return { config: null, options: DEFAULT_OPTIONS, files: glob() };
  const root = parseConfig(configFile, warnings);
  if (typeof root === 'string') {
    if (explicit) return root;
    warnings.push(`${root}; using the default options`);
    return { config: null, options: DEFAULT_OPTIONS, files: glob() };
  }
  const inSource = (c: ParsedConfig) => c.fileNames.filter((f) => isInside(f, sourceDir));
  let configs = [root];
  if (inSource(root).length === 0 && root.references.length > 0) {
    configs = [];
    for (const ref of root.references) {
      const c = parseConfig(ref, warnings);
      if (typeof c === 'string') warnings.push(c);
      else configs.push(c);
    }
  }
  let best = root;
  let most = -1;
  for (const c of configs) {
    const n = inSource(c).length;
    if (n > most) [best, most] = [c, n];
  }
  return {
    config: best.file,
    options: best.options,
    files: [...new Set(configs.flatMap(inSource))],
  };
}

function matching(patterns: string[], cwd: string): Set<string> {
  if (patterns.length === 0) return new Set();
  return new Set(
    globSync(patterns, { cwd, absolute: true, dot: true, ignore: ['**/node_modules/**'] }).map(
      slash,
    ),
  );
}

function gitIgnored(repoRoot: string, files: string[]): Set<string> {
  if (files.length === 0) return new Set();
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', 'check-ignore', '--stdin', '-z'], {
    cwd: repoRoot,
    input: files.map((f) => relative(repoRoot, f)).join('\0'),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  // 1: nothing ignored; 128: not a git repository (or no git): nothing to skip.
  if (r.status !== 0) return new Set();
  return new Set(
    r.stdout
      .split('\0')
      .filter((p) => p !== '')
      .map((p) => slash(resolve(repoRoot, p))),
  );
}

function usesPackage(specifiers: Set<string>, pkg: string): boolean {
  for (const s of specifiers) if (s === pkg || s.startsWith(`${pkg}/`)) return true;
  return false;
}

// D2: the package's own types when it resolves to a declaration or TypeScript file; an untyped
// JavaScript resolution counts as not resolved.
function installedVersion(
  pkg: string,
  from: string,
  options: ts.CompilerOptions,
): { version: string | null } | undefined {
  const modes = [undefined, ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS] as const;
  for (const mode of modes) {
    const r = ts.resolveModuleName(
      pkg,
      from,
      options,
      ts.sys,
      undefined,
      undefined,
      mode,
    ).resolvedModule;
    if (!r || !TYPED_EXTENSIONS.has(r.extension)) continue;
    if (r.packageId?.name === pkg) return { version: r.packageId.version };
    return { version: packageVersion(pkg, r.resolvedFileName) };
  }
  return undefined;
}

function packageVersion(pkg: string, file: string): string | null {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (json.name === pkg) return typeof json.version === 'string' ? json.version : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function createSourceProgram(input: ProgramInput): ProgramResult {
  const repoRoot = resolve(input.repoRoot);
  const { source } = input;
  const sourceDir = resolve(repoRoot, source.path);
  if (!isInside(sourceDir, repoRoot))
    return {
      ok: false,
      error: `source "${source.name}": path ${source.path} is outside the repository`,
    };
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory())
    return { ok: false, error: `source "${source.name}": path ${source.path} is not a directory` };

  let configFile: string | undefined;
  if (source.tsconfig !== undefined) {
    configFile = resolve(repoRoot, source.tsconfig);
    if (!existsSync(configFile))
      return { ok: false, error: `source "${source.name}": tsconfig ${source.tsconfig} not found` };
  } else {
    configFile = nearestConfig(sourceDir, repoRoot);
  }
  const warnings: string[] = [];
  const found = candidates(sourceDir, configFile, source.tsconfig !== undefined, warnings);
  if (typeof found === 'string') return { ok: false, error: `source "${source.name}": ${found}` };

  const all = found.files
    .filter((f) => CODE_FILE.test(f) && !f.split('/').includes('node_modules'))
    .sort();
  const declarations = all.filter((f) => DECLARATION_FILE.test(f));
  const code = all.filter((f) => !DECLARATION_FILE.test(f));

  const skipped = Object.fromEntries(SKIP_REASONS.map((r) => [r, [] as string[]])) as Record<
    SkipReason,
    string[]
  >;
  const sourceRel = slash(relative(repoRoot, sourceDir));
  const rel = (f: string) => slash(relative(repoRoot, f));
  const isBuildOutput = (f: string) =>
    slash(relative(sourceDir, f))
      .split('/')
      .slice(0, -1)
      .some((s) => BUILD_OUTPUTS.includes(s));
  const ignored = gitIgnored(repoRoot, code);
  const tests = matching(TEST_PATTERNS, sourceDir);
  const excluded = matching(input.exclude ?? [], repoRoot);

  const files: string[] = [];
  const unreadable: string[] = [];
  const specifiers = new Map<string, Set<string>>();
  for (const f of code) {
    let reason: SkipReason | undefined;
    if (isBuildOutput(f)) reason = 'build-output';
    else if (ignored.has(f)) reason = 'git-ignored';
    else if (tests.has(f)) reason = 'test-or-story';
    else if (excluded.has(f)) reason = 'config-exclude';
    if (reason) {
      skipped[reason].push(rel(f));
      continue;
    }
    try {
      if (statSync(f).size > MAX_FILE_BYTES) {
        skipped.oversize.push(rel(f));
        continue;
      }
      const text = readFileSync(f, 'utf8');
      const imports = ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName);
      specifiers.set(f, new Set(imports));
    } catch {
      unreadable.push(rel(f));
      continue;
    }
    files.push(f);
  }

  const options: ts.CompilerOptions = { ...found.options, allowJs: true, noEmit: true };
  delete options.plugins;

  const sdks: SdkTypes[] = [];
  for (const descriptor of [...input.descriptors].sort((a, b) => a.sdk.localeCompare(b.sdk))) {
    const from = files.find((f) => usesPackage(specifiers.get(f) ?? new Set(), descriptor.package));
    if (!from) continue;
    const installed = installedVersion(descriptor.package, from, options);
    sdks.push(
      installed
        ? {
            descriptor,
            sdk: { id: descriptor.sdk, version: installed.version, types: 'installed' },
            stub: null,
          }
        : {
            descriptor,
            sdk: { id: descriptor.sdk, version: null, types: 'stub' },
            stub: slash(descriptor.stub.file),
          },
    );
  }

  // An ambient module declaration wins over a resolved package (ADR-021), so a stub joins the
  // program only for a package that does not resolve.
  const stubs = sdks.flatMap((s) => (s.stub ? [s.stub] : []));
  const program = ts.createProgram({ rootNames: [...files, ...declarations, ...stubs], options });
  const excludedFiles =
    skipped['build-output'].length +
    skipped['git-ignored'].length +
    skipped['test-or-story'].length +
    skipped['config-exclude'].length;
  return {
    ok: true,
    value: {
      program,
      root: sourceRel === '' ? '.' : sourceRel,
      tsconfig: found.config ? rel(found.config) : null,
      files,
      skipped,
      unreadable,
      sdks,
      warnings,
      coverage: { files: files.length, excludedFiles, oversizeFiles: skipped.oversize.length },
    },
  };
}
