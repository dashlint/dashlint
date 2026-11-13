// dashlint.config.yml (spec 6.8): every key checked, unknown keys named with a did-you-mean, `key`
// only as env:NAME, paths relative to the config.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../../../src/cli/args.js';
import { loadConfig } from '../../../src/cli/config.js';

const LITERAL_KEY_SENTENCE = 'Put the key in an environment variable and write `key: env:NAME`.';

const FULL = `version: 1
requirements: dashlint.requirements.json
platforms:
  posthog:
    host: https://us.posthog.com
    project: 12345
    key: env:DASHLINT_POSTHOG_KEY
    observedDays: 30
    hogql: false
sources:
  - name: web
    path: web
    platform: web
  - name: mobile
    path: mobile
    platform: [ios, android]
    tsconfig: mobile/tsconfig.json
catalogs:
  - path: catalogs/server.json
exclude: ['**/*.stories.tsx']
ignore:
  - tile: insight:Ab12Cd34
    reason: retired on purpose
    until: 2027-06-30
failOn: dead
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashlint-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function load(text: string) {
  const file = join(dir, 'dashlint.config.yml');
  writeFileSync(file, text);
  return loadConfig(file);
}

function error(text: string): string {
  try {
    load(text);
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).exitCode).toBe(2);
    return (e as CliError).message;
  }
  throw new Error('the config loaded');
}

describe('loadConfig', () => {
  it('reads the spec 6.8 example, paths made absolute against the config folder', () => {
    const c = load(FULL);
    expect(c.requirements).toBe(join(dir, 'dashlint.requirements.json'));
    expect(c.posthog).toEqual({
      host: 'https://us.posthog.com',
      project: 12345,
      key: 'env:DASHLINT_POSTHOG_KEY',
      observedDays: 30,
      hogql: false,
      redact: false,
    });
    expect(c.sources).toEqual([
      { name: 'web', path: 'web', platforms: ['web'] },
      {
        name: 'mobile',
        path: 'mobile',
        platforms: ['ios', 'android'],
        tsconfig: 'mobile/tsconfig.json',
      },
    ]);
    expect(c.catalogs).toEqual([join(dir, 'catalogs/server.json')]);
    expect(c.exclude).toEqual(['**/*.stories.tsx']);
    expect(c.ignore).toEqual([
      { kind: 'tile', id: 'insight:Ab12Cd34', reason: 'retired on purpose', until: '2027-06-30' },
    ]);
    expect(c.failOn).toBe('dead');
  });

  it('defaults: requirements file, failOn dead, empty lists, no platform', () => {
    const c = load('version: 1\n');
    expect(c).toMatchObject({
      requirements: join(dir, 'dashlint.requirements.json'),
      failOn: 'dead',
      sources: [],
      catalogs: [],
      exclude: [],
      ignore: [],
    });
    expect(c.posthog).toBeUndefined();
  });

  it('negative control: keey is exit 2 naming the line and key', () => {
    expect(error(FULL.replace('    key:', '    keey:'))).toBe(
      `${join(dir, 'dashlint.config.yml')}: line 7: platforms.posthog.keey is not a known key; did you mean \`key\`?`,
    );
  });

  it('negative control: a literal key is exit 2 with the 6.8 sentence only', () => {
    expect(error(FULL.replace('env:DASHLINT_POSTHOG_KEY', 'phx_literal'))).toBe(
      LITERAL_KEY_SENTENCE,
    );
    expect(error(FULL.replace('env:DASHLINT_POSTHOG_KEY', '12345'))).toBe(LITERAL_KEY_SENTENCE);
    expect(error(FULL.replace('env:DASHLINT_POSTHOG_KEY', 'env:1BAD'))).toBe(LITERAL_KEY_SENTENCE);
  });

  it.each([
    [
      'unknown top key',
      'version: 1\nfialOn: dead\n',
      'line 2: fialOn is not a known key; did you mean `failOn`?',
    ],
    ['far unknown key', 'version: 1\ncolour: red\n', 'colour is not a known key'],
    [
      'unknown platform',
      'platforms:\n  posthgo: {}\n',
      'platforms.posthgo is not a known key; did you mean `posthog`?',
    ],
    [
      'unknown source key',
      FULL.replace('    tsconfig:', '    tsconfg:'),
      'sources[1].tsconfg is not a known key; did you mean `tsconfig`?',
    ],
    [
      'unknown ignore key',
      FULL.replace('    reason:', '    reasn:'),
      'ignore[0].reasn is not a known key; did you mean `reason`?',
    ],
    [
      'unknown catalog key',
      FULL.replace('  - path: catalogs', '  - pth: catalogs'),
      'catalogs[0].pth is not a known key; did you mean `path`?',
    ],
    ['version 2', 'version: 2\n', 'version must be 1'],
    ['failOn wrong', 'failOn: all\n', 'failOn must be one of dead, partly-dead, degraded, never'],
    [
      'source no name',
      'sources:\n  - path: web\n    platform: web\n',
      'sources[0].name must be a name',
    ],
    [
      'source no platform',
      'sources:\n  - name: web\n    path: web\n',
      'sources[0].platform must be a platform name',
    ],
    [
      'source bad platform',
      'sources:\n  - name: web\n    path: web\n    platform: [Web]\n',
      'sources[0].platform must be',
    ],
    [
      'two sources one name',
      'sources:\n  - {name: web, path: a, platform: web}\n  - {name: web, path: b, platform: web}\n',
      'two sources are named web',
    ],
    ['sources a mapping', 'sources: {}\n', 'sources must be a list'],
    ['exclude a number', 'exclude: [3]\n', 'exclude[0] must be a glob'],
    [
      'ignore no reason',
      'ignore:\n  - tile: Ab12\n',
      'ignore[0].reason: say why the tile is ignored',
    ],
    [
      'observedDays 0',
      FULL.replace('observedDays: 30', 'observedDays: 0'),
      'observedDays must be a whole number of days',
    ],
    [
      'hogql text',
      FULL.replace('hogql: false', 'hogql: "no"'),
      'platforms.posthog.hogql must be true or false',
    ],
    ['no host', FULL.replace(/ {4}host:.*\n/, ''), 'platforms.posthog.host is missing'],
    ['not a mapping', '- 1\n', 'the config must be a mapping'],
    ['a custom tag', 'version: !foo 1\n', 'dashlint.config.yml: '],
  ])('%s is exit 2', (_label, text, message) => {
    expect(error(text)).toContain(message);
  });

  it('a missing file is exit 2 naming it', () => {
    try {
      loadConfig(join(dir, 'none.yml'));
      throw new Error('loaded');
    } catch (e) {
      expect((e as CliError).exitCode).toBe(2);
      expect((e as CliError).message).toContain(`cannot read the config ${join(dir, 'none.yml')}`);
    }
  });
});
