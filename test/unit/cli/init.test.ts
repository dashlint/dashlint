import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configText, detectSources } from '../../../src/cli/commands/init.js';
import { loadConfig } from '../../../src/cli/config.js';
import { run } from '../../../src/cli/main.js';
import { loadDescriptors, type Descriptor } from '../../../src/descriptors/index.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/cli/init/', import.meta.url));
const loaded = loadDescriptors();
if (!loaded.ok) throw new Error('descriptors do not load');
const all: Descriptor[] = loaded.value;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch copy of a fixture repo (init writes into it). */
function copyOf(fixture?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dashlint-init-'));
  dirs.push(dir);
  if (fixture !== undefined) cpSync(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

async function runIn(cwd: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd,
    env: {},
    tool: '0.1.0',
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const read = (dir: string, file = 'dashlint.config.yml') => readFileSync(join(dir, file), 'utf8');

describe('dashlint init: detection', () => {
  it('a single app with posthog-js is one web source at the root', () => {
    const d = detectSources(join(FIXTURES, 'single'), all);
    expect(d).toEqual({
      workspaces: false,
      skipped: [],
      sources: [{ name: 'storefront', path: '.', platforms: ['web'], packages: ['posthog-js'] }],
    });
  });

  it('a monorepo gives one source per workspace with an SDK, Expo as ios and android', () => {
    const d = detectSources(join(FIXTURES, 'monorepo'), all);
    expect(d.workspaces).toBe(true);
    expect(d.sources).toEqual([
      {
        name: 'mobile',
        path: 'apps/mobile',
        platforms: ['ios', 'android'],
        packages: ['posthog-react-native'],
      },
      { name: 'web', path: 'apps/web', platforms: ['web'], packages: ['posthog-js'] },
    ]);
  });

  it('a workspace without an SDK and an excluded workspace give no source', () => {
    const names = detectSources(join(FIXTURES, 'monorepo'), all).sources.map((s) => s.path);
    expect(names).not.toContain('packages/ui');
    expect(names).not.toContain('packages/legacy');
  });

  it('reads pnpm-workspace.yaml and the workspaces.packages form', () => {
    const pnpm = copyOf();
    writeFileSync(join(pnpm, 'package.json'), '{"name":"shop"}');
    writeFileSync(join(pnpm, 'pnpm-workspace.yaml'), "packages:\n  - 'shop/*'\n");
    mkdirSync(join(pnpm, 'shop', 'till'), { recursive: true });
    writeFileSync(
      join(pnpm, 'shop', 'till', 'package.json'),
      '{"devDependencies":{"posthog-js":"1"}}',
    );
    expect(detectSources(pnpm, all).sources.map((s) => [s.name, s.path])).toEqual([
      ['till', 'shop/till'],
    ]);

    const yarn = copyOf();
    writeFileSync(join(yarn, 'package.json'), '{"workspaces":{"packages":["apps/*/"]}}');
    mkdirSync(join(yarn, 'apps', 'Gift Cards'), { recursive: true });
    writeFileSync(
      join(yarn, 'apps', 'Gift Cards', 'package.json'),
      '{"peerDependencies":{"posthog-react-native":"4"}}',
    );
    expect(detectSources(yarn, all).sources).toEqual([
      {
        name: 'gift-cards',
        path: 'apps/Gift Cards',
        platforms: ['ios', 'android'],
        packages: ['posthog-react-native'],
      },
    ]);
  });

  it('gives two workspaces of the same folder name distinct source names', () => {
    const dir = copyOf();
    writeFileSync(join(dir, 'package.json'), '{"workspaces":["a/*","b/*"]}');
    for (const p of ['a/app', 'b/app']) {
      mkdirSync(join(dir, p), { recursive: true });
      writeFileSync(join(dir, p, 'package.json'), '{"dependencies":{"posthog-js":"1"}}');
    }
    expect(detectSources(dir, all).sources.map((s) => [s.name, s.path])).toEqual([
      ['app', 'a/app'],
      ['app-2', 'b/app'],
    ]);
  });

  it('skips an unreadable package.json and names it; an app without an SDK is no source', () => {
    const dir = copyOf();
    writeFileSync(join(dir, 'package.json'), '{"workspaces":["apps/*"]}');
    mkdirSync(join(dir, 'apps', 'broken'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'broken', 'package.json'), '{ not json');
    expect(detectSources(dir, all)).toEqual({
      workspaces: true,
      sources: [],
      skipped: ['apps/broken/package.json'],
    });
    const plain = copyOf();
    writeFileSync(join(plain, 'package.json'), '{"dependencies":{"react":"19"}}');
    expect(detectSources(plain, all).sources).toEqual([]);
  });
});

describe('dashlint init: the command', () => {
  it('writes a config for a single app that loads and extracts', async () => {
    const dir = copyOf('single');
    const r = await runIn(dir, ['init']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('with 1 source: storefront (., web)');
    const config = loadConfig(join(dir, 'dashlint.config.yml'));
    expect(config.sources).toEqual([{ name: 'storefront', path: '.', platforms: ['web'] }]);
    expect(config.posthog).toBeUndefined();
    expect(config.failOn).toBe('dead');
    expect(config.requirements).toBe(join(dir, 'dashlint.requirements.json'));

    const e = await runIn(dir, ['extract', '--quiet', '--out', '-']);
    expect(e.code).toBe(0);
    expect(Object.keys((JSON.parse(e.out) as { events: object }).events)).toContain(
      'cart_book_added',
    );
  });

  it('writes a config for a monorepo with web and Expo that loads and extracts both', async () => {
    const dir = copyOf('monorepo');
    const r = await runIn(dir, ['init']);
    expect(r.code).toBe(0);
    const config = loadConfig(join(dir, 'dashlint.config.yml'));
    expect(config.sources).toEqual([
      { name: 'mobile', path: 'apps/mobile', platforms: ['ios', 'android'] },
      { name: 'web', path: 'apps/web', platforms: ['web'] },
    ]);
    const e = await runIn(dir, ['extract', '--quiet']);
    expect(e.code).toBe(0);
    expect(read(dir, 'mobile.catalog.json')).toContain('"chapter_opened"');
    expect(read(dir, 'web.catalog.json')).toContain('"shelf_searched"');
  });

  it('keeps every key of the config visible, the PostHog block commented with env:NAME', () => {
    const text = configText(detectSources(join(FIXTURES, 'monorepo'), all), all);
    for (const key of [
      'version:',
      'requirements:',
      'sources:',
      'catalogs:',
      'exclude:',
      'ignore:',
      'failOn:',
    ])
      expect(text).toMatch(new RegExp(`^${key}`, 'm'));
    for (const key of ['platforms:', 'posthog:', 'host:', 'project:', 'key: env:', 'observedDays:'])
      expect(text).toMatch(new RegExp(`^#\\s+${key}`, 'm'));
    expect(text).toContain('    platform: [ios, android]\n');
    expect(text).toContain('  # posthog-react-native in apps/mobile/package.json\n');
  });

  it('with no SDK it writes a config with no sources and says so', async () => {
    const dir = copyOf();
    writeFileSync(join(dir, 'package.json'), '{"dependencies":{"react":"19"}}');
    const r = await runIn(dir, ['init']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('with no sources');
    expect(read(dir)).toContain('# No app here depends on posthog-js, posthog-react-native.');
    expect(loadConfig(join(dir, 'dashlint.config.yml')).sources).toEqual([]);
  });

  it('works with no package.json at all', async () => {
    const dir = copyOf();
    expect((await runIn(dir, ['init'])).code).toBe(0);
    expect(loadConfig(join(dir, 'dashlint.config.yml')).sources).toEqual([]);
  });

  it('writes to --config and finds the apps beside it', async () => {
    const dir = copyOf();
    cpSync(join(FIXTURES, 'single'), join(dir, 'shop'), { recursive: true });
    const r = await runIn(dir, ['init', '--config', 'shop/dashlint.yml']);
    expect(r.code).toBe(0);
    expect(loadConfig(join(dir, 'shop', 'dashlint.yml')).sources.map((s) => s.path)).toEqual(['.']);
  });

  it('leaves an existing config untouched without --yes (exit 2)', async () => {
    const dir = copyOf('single');
    const mine = 'version: 1\nsources: []\n# mine\n';
    writeFileSync(join(dir, 'dashlint.config.yml'), mine);
    const r = await runIn(dir, ['init']);
    expect(r.code).toBe(2);
    expect(r.err).toBe(
      `dashlint init: ${join(dir, 'dashlint.config.yml')} already exists and was left as it is; pass --yes to replace it`,
    );
    expect(read(dir)).toBe(mine);
  });

  it('replaces an existing config with --yes', async () => {
    const dir = copyOf('single');
    writeFileSync(join(dir, 'dashlint.config.yml'), '# mine\n');
    const r = await runIn(dir, ['init', '--yes']);
    expect(r.code).toBe(0);
    expect(read(dir)).not.toContain('# mine');
    expect(loadConfig(join(dir, 'dashlint.config.yml')).sources).toHaveLength(1);
  });

  it('--yes takes no value, and is not an option of other commands', async () => {
    const dir = copyOf('single');
    expect((await runIn(dir, ['init', '--yes=1'])).err).toBe('dashlint init: --yes takes no value');
    expect((await runIn(dir, ['extract', '--yes'])).code).toBe(2);
    expect((await runIn(dir, ['init', '--ye'])).err).toBe(
      'dashlint init: unknown option --ye; did you mean --yes?',
    );
  });

  it('--quiet prints nothing on success', async () => {
    const dir = copyOf('single');
    expect(await runIn(dir, ['init', '--quiet'])).toEqual({ code: 0, out: '', err: '' });
  });
});
