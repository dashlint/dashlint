// T3.2: one program per source, the files it analyses and skips (spec 6.4 item 1), and where each
// SDK's types come from (item 2, D2). The fixtures are mini repos with synthetic bookshop names.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDescriptors, type Descriptor } from '../../../src/descriptors/index.js';
import {
  createSourceProgram,
  MAX_FILE_BYTES,
  type ProgramInput,
  type SourceProgram,
} from '../../../src/extract/program.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/extract/posthog-js/', import.meta.url));

const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const descriptors: Descriptor[] = loaded.value;
const posthogJs = descriptors.find((d) => d.sdk === 'posthog-js');
if (!posthogJs) throw new Error('no posthog-js descriptor');

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dashlint-program-'));
  temps.push(dir);
  return dir;
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

function build(input: Partial<ProgramInput> & { repoRoot: string }): SourceProgram {
  const r = createSourceProgram({ source: { name: 'web', path: '.' }, descriptors, ...input });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function rel(sp: SourceProgram, root: string): string[] {
  return sp.files.map((f) => relative(root, f).replace(/\\/g, '/'));
}

// Every `capture` call in the analysed files, with the file that declares the resolved signature.
// T3.3 builds the real matcher; this only shows which declarations the program resolves to.
function captureCalls(sp: SourceProgram, root: string): { site: string; declaredIn: string }[] {
  const checker = sp.program.getTypeChecker();
  const out: { site: string; declaredIn: string }[] = [];
  for (const file of sp.files) {
    const source = sp.program.getSourceFile(file);
    if (!source) throw new Error(`no source file ${file}`);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && /\bcapture$/.test(node.expression.getText())) {
        const decl = checker.getResolvedSignature(node)?.declaration;
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        out.push({
          site: `${relative(root, file).replace(/\\/g, '/')}:${line}`,
          declaredIn: decl ? decl.getSourceFile().fileName : '-',
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

describe('SDK resolution (D2)', () => {
  it('adds the bundled stub when the package is not installed', () => {
    const root = join(FIXTURES, 'stub');
    const sp = build({ repoRoot: root });
    expect(sp.sdks.map((s) => s.sdk)).toEqual([{ id: 'posthog-js', version: null, types: 'stub' }]);
    expect(sp.sdks[0]?.stub).toBe(posthogJs.stub.file.replace(/\\/g, '/'));
    expect(sp.program.getSourceFile(posthogJs.stub.file)).toBeDefined();
    const calls = captureCalls(sp, root);
    expect(calls.map((c) => c.site)).toEqual([
      'src/gift-cards.js:4',
      'src/reader.ts:5',
      'src/shelf.ts:4',
    ]);
    for (const c of calls) expect(c.declaredIn).toBe(posthogJs.stub.file.replace(/\\/g, '/'));
  });

  it('uses the installed types and records their version', () => {
    const root = join(FIXTURES, 'installed');
    const sp = build({ repoRoot: root });
    expect(sp.sdks.map((s) => s.sdk)).toEqual([
      { id: 'posthog-js', version: '1.447.15', types: 'installed' },
    ]);
    expect(sp.sdks[0]?.stub).toBeNull();
    expect(sp.program.getSourceFile(posthogJs.stub.file)).toBeUndefined();
    const calls = captureCalls(sp, root);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.declaredIn).toBe(
      // The real path: Stryker's sandbox links the fixture's node_modules to the original.
      realpathSync(join(root, 'node_modules/posthog-js/dist/module.d.ts')).replace(/\\/g, '/'),
    );
  });

  it('uses the stub when the installed package has no types', () => {
    const root = temp();
    write(root, {
      'src/shelf.ts': "import posthog from 'posthog-js';\nposthog.capture('wishlist_shared');\n",
      'node_modules/posthog-js/package.json':
        '{"name":"posthog-js","version":"1.2.3","main":"index.js"}',
      'node_modules/posthog-js/index.js': 'export default { capture() {} };\n',
    });
    const sp = build({ repoRoot: root });
    expect(sp.sdks.map((s) => s.sdk)).toEqual([{ id: 'posthog-js', version: null, types: 'stub' }]);
    expect(captureCalls(sp, root)[0]?.declaredIn).toBe(posthogJs.stub.file.replace(/\\/g, '/'));
  });

  it('reads the version of a package mapped through paths from its package.json', () => {
    const root = temp();
    const shelf = "import posthog from 'posthog-js';\nposthog.capture('wishlist_shared');\n";
    const declaration =
      'declare const posthog: { capture(event: string): void };\nexport default posthog;\n';
    write(root, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          moduleResolution: 'Bundler',
          module: 'ESNext',
          paths: { 'posthog-js': ['./vendor/ph/index.d.ts'] },
        },
        include: ['src'],
      }),
      'src/shelf.ts': shelf,
      'vendor/ph/index.d.ts': declaration,
      'vendor/ph/package.json': '{"name":"posthog-js","version":"1.300.0"}',
    });
    const sp = build({ repoRoot: root });
    expect(sp.sdks.map((s) => s.sdk)).toEqual([
      { id: 'posthog-js', version: '1.300.0', types: 'installed' },
    ]);

    write(root, { 'vendor/ph/package.json': '{ "name": ' });
    expect(build({ repoRoot: root }).sdks.map((s) => s.sdk)).toEqual([
      { id: 'posthog-js', version: null, types: 'installed' },
    ]);
  });

  it('lists only the SDKs the source imports', () => {
    const root = temp();
    write(root, { 'src/genres.ts': "export const GENRES = ['poetry'];\n" });
    const sp = build({ repoRoot: root });
    expect(sp.sdks).toEqual([]);
    for (const d of descriptors) expect(sp.program.getSourceFile(d.stub.file)).toBeUndefined();
  });

  it('records the react-native SDK when only its package is imported', () => {
    const root = temp();
    write(root, {
      'src/app.ts':
        "import PostHog from 'posthog-react-native';\nconst client = new PostHog('shop-key');\nclient.capture('app_opened');\n",
    });
    const sp = build({ repoRoot: root });
    expect(sp.sdks.map((s) => s.sdk)).toEqual([
      { id: 'posthog-react-native', version: null, types: 'stub' },
    ]);
  });
});

describe('file selection (spec 6.4 item 1)', () => {
  it('skips and counts tests, stories, mocks, build outputs and config excludes', () => {
    const root = join(FIXTURES, 'excluded');
    const sp = build({ repoRoot: root, exclude: ['scripts/**'] });
    expect(rel(sp, root)).toEqual(['src/shelf.ts']);
    expect(sp.skipped).toEqual({
      'build-output': ['dist/bundle.js'],
      'git-ignored': [],
      'test-or-story': [
        'src/BookCard.stories.tsx',
        'src/__mocks__/posthog-js.ts',
        'src/__tests__/cart.ts',
        'src/checkout.spec.js',
        'src/shelf.test.ts',
      ],
      'config-exclude': ['scripts/seed.ts'],
      oversize: [],
    });
    expect(sp.coverage).toEqual({ files: 1, excludedFiles: 7, oversizeFiles: 0 });
    expect(sp.tsconfig).toBeNull();
    // Declaration files join the program but are not analysed or counted.
    expect(sp.program.getSourceFile(join(root, 'src/globals.d.ts'))).toBeDefined();
  });

  it('negative control: a test file that calls capture adds no site', () => {
    const root = join(FIXTURES, 'excluded');
    const sp = build({ repoRoot: root, exclude: ['scripts/**'] });
    expect(captureCalls(sp, root).map((c) => c.site)).toEqual(['src/shelf.ts:4']);
  });

  it('analyses config-excluded files when the config does not exclude them', () => {
    const root = join(FIXTURES, 'excluded');
    const sp = build({ repoRoot: root });
    expect(rel(sp, root)).toEqual(['scripts/seed.ts', 'src/shelf.ts']);
    expect(sp.coverage.excludedFiles).toBe(6);
  });

  it('skips and counts a file over 1 MB, and keeps one of exactly 1 MB', () => {
    const root = temp();
    const pad = (n: number, head: string) => head + '/'.repeat(n - head.length - 1) + '\n';
    write(root, {
      'src/shelf.ts': "import posthog from 'posthog-js';\nposthog.capture('wishlist_shared');\n",
      'src/catalog-data.ts': pad(
        MAX_FILE_BYTES + 1,
        "import posthog from 'posthog-js';\nposthog.capture('catalog_loaded');\n",
      ),
      'src/genres-data.ts': pad(MAX_FILE_BYTES, 'export const GENRES = 1;\n'),
    });
    const sp = build({ repoRoot: root });
    expect(rel(sp, root)).toEqual(['src/genres-data.ts', 'src/shelf.ts']);
    expect(sp.skipped.oversize).toEqual(['src/catalog-data.ts']);
    expect(sp.coverage).toEqual({ files: 2, excludedFiles: 0, oversizeFiles: 1 });
    expect(captureCalls(sp, root).map((c) => c.site)).toEqual(['src/shelf.ts:2']);
  });

  it('skips and counts git-ignored files', () => {
    const root = temp();
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
    write(root, {
      '.gitignore': 'generated/\n',
      'src/shelf.ts': "import posthog from 'posthog-js';\nposthog.capture('wishlist_shared');\n",
      'generated/client.ts': "import posthog from 'posthog-js';\nposthog.capture('generated');\n",
    });
    const sp = build({ repoRoot: root });
    expect(rel(sp, root)).toEqual(['src/shelf.ts']);
    expect(sp.skipped['git-ignored']).toEqual(['generated/client.ts']);
    expect(sp.coverage.excludedFiles).toBe(1);
  });

  // A file the user cannot read; root reads everything, and Windows ignores the mode bits.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'records an unreadable file and leaves it out',
    () => {
      const root = temp();
      write(root, {
        'src/shelf.ts': 'export const a = 1;\n',
        'src/locked.ts': 'export const b = 2;\n',
      });
      chmodSync(join(root, 'src/locked.ts'), 0o000);
      const sp = build({ repoRoot: root });
      chmodSync(join(root, 'src/locked.ts'), 0o644);
      expect(rel(sp, root)).toEqual(['src/shelf.ts']);
      expect(sp.unreadable).toEqual(['src/locked.ts']);
    },
  );

  it('skips nothing as git-ignored outside a git repository', () => {
    const root = temp();
    write(root, {
      '.gitignore': 'generated/\n',
      'generated/client.ts': 'export const x = 1;\n',
    });
    const sp = build({ repoRoot: root });
    expect(rel(sp, root)).toEqual(['generated/client.ts']);
  });

  it('never analyses node_modules, even when a tsconfig includes it', () => {
    const root = temp();
    write(root, {
      'tsconfig.json': '{"include": ["src", "node_modules/kit"]}',
      'src/shelf.ts': 'export const a = 1;\n',
      'node_modules/kit/index.ts': 'export const b = 2;\n',
    });
    const sp = build({ repoRoot: root });
    expect(rel(sp, root)).toEqual(['src/shelf.ts']);
    expect(sp.coverage).toEqual({ files: 1, excludedFiles: 0, oversizeFiles: 0 });
  });
});

describe('tsconfig discovery', () => {
  it('forces allowJs, so a config without it still counts .js files', () => {
    const root = join(FIXTURES, 'stub');
    const sp = build({ repoRoot: root });
    expect(sp.tsconfig).toBe('tsconfig.json');
    expect(rel(sp, root)).toEqual(['src/gift-cards.js', 'src/reader.ts', 'src/shelf.ts']);
    expect(sp.program.getCompilerOptions().allowJs).toBe(true);
    expect(sp.program.getCompilerOptions().noEmit).toBe(true);
  });

  it('uses the nearest tsconfig inside the repository and keeps to the source path', () => {
    const root = join(FIXTURES, 'nearest');
    const sp = build({ repoRoot: root, source: { name: 'web', path: 'apps/web' } });
    expect(sp.tsconfig).toBe('tsconfig.json');
    expect(sp.root).toBe('apps/web');
    expect(rel(sp, root)).toEqual(['apps/web/src/shelf.ts']);
  });

  it('uses the configured tsconfig', () => {
    const root = join(FIXTURES, 'nearest');
    const sp = build({
      repoRoot: root,
      source: { name: 'web', path: 'apps/web', tsconfig: 'apps/web/tsconfig.custom.json' },
    });
    expect(sp.tsconfig).toBe('apps/web/tsconfig.custom.json');
    expect(rel(sp, root)).toEqual(['apps/web/src/shelf.ts']);
  });

  it('follows the references of a solution-style tsconfig', () => {
    const root = join(FIXTURES, 'references');
    const sp = build({ repoRoot: root });
    expect(sp.tsconfig).toBe('tsconfig.app.json');
    expect(rel(sp, root)).toEqual(['shop.config.ts', 'src/genres.ts', 'src/main.ts']);
    expect(sp.program.getCompilerOptions().jsx).toBe(ts.JsxEmit.Preserve);
    expect(sp.warnings).toEqual([]);
  });

  it('globs the source with default options when there is no tsconfig', () => {
    const root = temp();
    write(root, { 'src/a.ts': 'export const a = 1;\n', 'src/b.mjs': 'export const b = 2;\n' });
    const sp = build({ repoRoot: root });
    expect(sp.tsconfig).toBeNull();
    expect(rel(sp, root)).toEqual(['src/a.ts', 'src/b.mjs']);
  });

  it('never loads compiler plugins', () => {
    const root = temp();
    write(root, {
      'tsconfig.json': '{"compilerOptions": {"plugins": [{"name": "shop-plugin"}]}}',
      'src/a.ts': 'export const a = 1;\n',
    });
    const sp = build({ repoRoot: root });
    expect(sp.program.getCompilerOptions().plugins).toBeUndefined();
  });

  it('keeps what it can read of a tsconfig with syntax errors, with a warning', () => {
    const root = temp();
    write(root, { 'tsconfig.json': '{ "compilerOptions": ', 'src/a.ts': 'export const a = 1;\n' });
    const sp = build({ repoRoot: root });
    expect(sp.tsconfig).toBe('tsconfig.json');
    expect(rel(sp, root)).toEqual(['src/a.ts']);
    expect(sp.warnings.length).toBeGreaterThan(0);
  });

  it('falls back to defaults with a warning when the nearest tsconfig cannot be read', () => {
    const root = temp();
    write(root, { 'tsconfig.json/README': 'a folder named like a config\n' });
    write(root, { 'src/a.ts': 'export const a = 1;\n' });
    const sp = build({ repoRoot: root });
    expect(sp.tsconfig).toBeNull();
    expect(rel(sp, root)).toEqual(['src/a.ts']);
    expect(sp.warnings.join('\n')).toMatch(/using the default options/);
  });

  it('keeps going when the tsconfig extends a package that is not installed', () => {
    const root = temp();
    write(root, {
      'tsconfig.json': '{"extends": "shop-base/tsconfig.json", "include": ["src"]}',
      'src/a.ts': 'export const a = 1;\n',
    });
    const sp = build({ repoRoot: root });
    expect(sp.tsconfig).toBe('tsconfig.json');
    expect(rel(sp, root)).toEqual(['src/a.ts']);
    expect(sp.warnings.join('\n')).toMatch(/shop-base/);
  });
});

describe('errors', () => {
  it('names a missing source path', () => {
    const r = createSourceProgram({
      repoRoot: join(FIXTURES, 'nearest'),
      source: { name: 'web', path: 'apps/shop' },
      descriptors,
    });
    expect(r).toEqual({ ok: false, error: 'source "web": path apps/shop is not a directory' });
  });

  it('refuses a source path outside the repository', () => {
    const r = createSourceProgram({
      repoRoot: join(FIXTURES, 'nearest'),
      source: { name: 'web', path: '../stub' },
      descriptors,
    });
    expect(r).toEqual({
      ok: false,
      error: 'source "web": path ../stub is outside the repository',
    });
  });

  it('names a configured tsconfig that does not exist', () => {
    const r = createSourceProgram({
      repoRoot: join(FIXTURES, 'nearest'),
      source: { name: 'web', path: 'apps/web', tsconfig: 'apps/web/tsconfig.missing.json' },
      descriptors,
    });
    expect(r).toEqual({
      ok: false,
      error: 'source "web": tsconfig apps/web/tsconfig.missing.json not found',
    });
  });

  it('refuses a configured tsconfig that cannot be read', () => {
    const root = temp();
    write(root, { 'shop.json/README': 'a folder\n', 'src/a.ts': 'export const a = 1;\n' });
    const r = createSourceProgram({
      repoRoot: root,
      source: { name: 'web', path: '.', tsconfig: 'shop.json' },
      descriptors,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^source "web": /);
  });
});

describe('fixture copies', () => {
  it('give the same result from another location', () => {
    const root = temp();
    cpSync(join(FIXTURES, 'excluded'), root, { recursive: true });
    const sp = build({ repoRoot: root, exclude: ['scripts/**'] });
    expect(rel(sp, root)).toEqual(['src/shelf.ts']);
    expect(sp.coverage).toEqual({ files: 1, excludedFiles: 7, oversizeFiles: 0 });
  });
});
