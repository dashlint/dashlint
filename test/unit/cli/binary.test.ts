// The built binary on fixtures (T7.4): every exit code of spec 6.9.2 and the golden text report.
// The bookshop catalogs and requirements files are written from test/fixtures/report/bookshop.ts
// (UPDATE_GOLDEN=1 only) and must stay equal to it.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requirementsJson } from '../../../src/adapters/posthog/pull.js';
import { readVersion, run } from '../../../src/cli/main.js';
import { writeCatalog } from '../../../src/extract/catalog.js';
import type { Catalog } from '../../../src/formats/catalog.js';
import { validateCatalog, validateReport } from '../../../src/formats/validate.js';
import { BUG_REPORT } from '../../../src/report/messages.js';
import { catalogs, requirements } from '../../fixtures/report/bookshop.js';
import { expectGolden } from '../report/golden.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const BIN = join(ROOT, 'dist/cli/main.js');
const FIXTURES = join(ROOT, 'test/fixtures/cli/bookshop');
const WEB = join(FIXTURES, 'web.catalog.json');
const MOBILE = join(FIXTURES, 'mobile.catalog.json');
const REQUIREMENTS = join(FIXTURES, 'requirements.json');
const GOLDEN = join(ROOT, 'test/golden/text/bookshop-no-ignore.txt');
const LITERAL_KEY_SENTENCE = 'Put the key in an environment variable and write `key: env:NAME`.';

function bin(args: string[], cwd = ROOT, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', NO_COLOR: '1', ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const CHECK = ['check', '--requirements', REQUIREMENTS, '--catalog', WEB, '--catalog', MOBILE];

/** The golden as this build prints it: the header names the running version, the golden 0.1.0. */
function golden(): string {
  const text = readFileSync(GOLDEN, 'utf8');
  expect(text.startsWith('dashlint 0.1.0 · ')).toBe(true);
  return text.replace(/^dashlint 0\.1\.0 /, `dashlint ${readVersion()} `);
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashlint-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bookshop fixture files', () => {
  it('equal the TypeScript fixture', () => {
    const [web, mobile] = catalogs() as [Catalog, Catalog];
    expectGolden('../fixtures/cli/bookshop/web.catalog.json', writeCatalog(web));
    expectGolden('../fixtures/cli/bookshop/mobile.catalog.json', writeCatalog(mobile));
    expectGolden('../fixtures/cli/bookshop/requirements.json', requirementsJson(requirements()));
  });
});

describe('dashlint check, the built binary (spec 6.9.1, 6.9.2)', () => {
  it('prints the golden text and exits 1 for dead tiles (failOn dead by default)', () => {
    const r = bin(CHECK);
    expect(r.out).toBe(golden());
    expect(r.err).toBe('');
    expect(r.code).toBe(1);
  });

  it('exit 0 with --fail-on never, the same report', () => {
    const r = bin([...CHECK, '--fail-on', 'never']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(golden());
  });

  it('exit 0 when no tile is at or above failOn: the live tile alone', () => {
    const req = requirements();
    req.tiles = req.tiles.filter((t) => t.id === 'insight:Bv01');
    req.alerts = [];
    writeFileSync(join(dir, 'live.json'), requirementsJson(req));
    const r = bin([
      'check',
      '--requirements',
      join(dir, 'live.json'),
      '--catalog',
      WEB,
      '--catalog',
      MOBILE,
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 tiles?/);
  });

  it('--format json writes a valid report to --out', () => {
    const out = join(dir, 'report.json');
    const r = bin([...CHECK, '--format', 'json', '--out', out]);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toBe(`check: wrote ${out}\n`);
    expect(validateReport(JSON.parse(readFileSync(out, 'utf8'))).ok).toBe(true);
    expect(bin([...CHECK, '--format', 'json', '--out', out, '--quiet']).err).toBe('');
  });

  it('--format html prints the HTML report', () => {
    const r = bin([...CHECK, '--format', 'html']);
    expect(r.out.startsWith('<!doctype html>')).toBe(true);
  });

  it('reads the config: sources are extracted, ignore and failOn apply, --cwd moves the start', () => {
    cpSync(join(ROOT, 'test/fixtures/extract/posthog-js/calls'), dir, { recursive: true });
    writeFileSync(
      join(dir, 'dashlint.config.yml'),
      `version: 1
requirements: requirements.json
sources:
  - name: web
    path: src
    platform: web
failOn: never
`,
    );
    cpSync(REQUIREMENTS, join(dir, 'requirements.json'));
    const r = bin(['check', '--cwd', dir, '--format', 'json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { catalogs: { source: string }[] };
    expect(report.catalogs.map((c) => c.source)).toEqual(['web']);
    expect(bin(['check', '--cwd', dir, '--fail-on', 'dead']).code).toBe(1);
  });

  it('exit 2: usage and config errors, each named (negative controls)', () => {
    const typo = bin(['chek']);
    expect(typo.code).toBe(2);
    expect(typo.err).toBe('dashlint: unknown command chek; did you mean check?\n');

    const flag = bin([...CHECK, '--fromat', 'json']);
    expect(flag.code).toBe(2);
    expect(flag.err).toBe('dashlint check: unknown option --fromat; did you mean --format?\n');

    const choice = bin([...CHECK, '--fail-on', 'broken']);
    expect(choice.code).toBe(2);
    expect(choice.err).toContain(
      '--fail-on broken is not one of dead, partly-dead, degraded, never',
    );

    const noReq = bin(['check', '--requirements', join(dir, 'none.json'), '--catalog', WEB]);
    expect(noReq.code).toBe(2);
    expect(noReq.err).toContain('no requirements file at');

    const notCatalog = bin(['check', '--requirements', REQUIREMENTS, '--catalog', REQUIREMENTS]);
    expect(notCatalog.code).toBe(2);
    expect(notCatalog.err).toContain(REQUIREMENTS);

    const noConfig = bin(['check', '--cwd', dir]);
    expect(noConfig.code).toBe(2);
    expect(noConfig.err).toContain('no config at');
    expect(noConfig.out).toBe('');
  });

  it('negative control: a config with keey: exits 2 naming key', () => {
    writeFileSync(
      join(dir, 'dashlint.config.yml'),
      `version: 1
platforms:
  posthog:
    host: https://us.posthog.com
    project: 12345
    keey: env:DASHLINT_POSTHOG_KEY
`,
    );
    const r = bin([...CHECK, '--cwd', dir]);
    expect(r.code).toBe(2);
    expect(r.err).toBe(
      `dashlint check: ${join(dir, 'dashlint.config.yml')}: line 6: platforms.posthog.keey is not a known key; did you mean \`key\`?\n`,
    );
  });

  it('negative control: a literal key exits 2 with the 6.8 sentence and never prints the key', () => {
    writeFileSync(
      join(dir, 'dashlint.config.yml'),
      `version: 1
platforms:
  posthog:
    host: https://us.posthog.com
    project: 12345
    key: phx_literal_test_only
`,
    );
    for (const command of [
      [...CHECK, '--cwd', dir],
      ['pull', '--cwd', dir],
      ['extract', '--cwd', dir],
    ]) {
      const r = bin(command);
      expect(r.code).toBe(2);
      expect(r.err).toContain(LITERAL_KEY_SENTENCE);
      expect(`${r.out}${r.err}`).not.toContain('phx_literal_test_only');
    }
  });

  it('exit 4: pull with the key variable unset names the variable, no request made', () => {
    writeFileSync(
      join(dir, 'dashlint.config.yml'),
      `version: 1
platforms:
  posthog:
    host: https://us.posthog.com
    project: 12345
    key: env:DASHLINT_TEST_UNSET_KEY
`,
    );
    const r = bin(['pull', '--cwd', dir]);
    expect(r.code).toBe(4);
    expect(r.err).toContain('DASHLINT_TEST_UNSET_KEY is not set or empty');
  });

  it('exit 3: an unexpected error prints the 6.9.2 bug sentence', async () => {
    const err: string[] = [];
    const code = await run(CHECK.slice(), {
      cwd: ROOT,
      env: {},
      stdout: () => {
        throw new Error('stdout closed');
      },
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(3);
    expect(err.join('\n')).toBe(`dashlint check: unexpected error: stdout closed\n${BUG_REPORT}`);
    expect(BUG_REPORT).toBe(
      'This is a bug in dashlint. Please report it at https://github.com/dashlint/dashlint/issues with the output above.',
    );
  });
});

describe('dashlint extract, the built binary', () => {
  beforeEach(() => {
    cpSync(join(ROOT, 'test/fixtures/extract/posthog-js/calls'), dir, { recursive: true });
    writeFileSync(
      join(dir, 'dashlint.config.yml'),
      `version: 1
sources:
  - name: web
    path: src
    platform: web
  - name: admin
    path: src
    platform: [web]
`,
    );
  });

  it('writes <name>.catalog.json per source next to the config; --out - prints one', () => {
    const r = bin(['extract', '--cwd', dir]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(
      /^extract: wrote .*web\.catalog\.json \(source web, \d+ events?, name resolution/m,
    );
    const web = JSON.parse(readFileSync(join(dir, 'web.catalog.json'), 'utf8')) as unknown;
    expect(validateCatalog(web).ok).toBe(true);
    expect(
      validateCatalog(JSON.parse(readFileSync(join(dir, 'admin.catalog.json'), 'utf8'))).ok,
    ).toBe(true);

    const one = bin(['extract', '--cwd', dir, '--source', 'web', '--out', '-']);
    expect(one.code).toBe(0);
    expect(one.out).toBe(readFileSync(join(dir, 'web.catalog.json'), 'utf8'));
  });

  it('exit 2: an unknown source with a did-you-mean; --out with several sources; a missing path', () => {
    const typo = bin(['extract', '--cwd', dir, '--source', 'wbe']);
    expect(typo.code).toBe(2);
    expect(typo.err).toBe('dashlint extract: no source is named wbe; did you mean web?\n');
    const several = bin(['extract', '--cwd', dir, '--out', 'x.json']);
    expect(several.code).toBe(2);
    expect(several.err).toContain('add --source <name>');
    writeFileSync(
      join(dir, 'dashlint.config.yml'),
      'sources:\n  - name: web\n    path: nowhere\n    platform: web\n',
    );
    const missing = bin(['extract', '--cwd', dir]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('source web: path nowhere is not a folder');
  });
});
