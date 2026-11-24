// Spec 6.13 as tests (T10.4, G4, G12): the offline commands open no socket, the PostHog key never
// reaches any output stream even at debug level, YAML custom tags are refused wherever YAML is read,
// no workflow or action file uses the risky trigger, and the npm tarball holds only what it should.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { npmCommand } from '../../../scripts/denylist-scan.mjs';
import { debugOn } from '../../../src/cli/commands/pull.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const BIN = join(ROOT, 'dist/cli/main.js');
// --import takes a URL: a drive letter reads as a scheme on Windows.
const HOOK = pathToFileURL(join(ROOT, 'test/fixtures/cli/no-network.mjs')).href;
const BOOKSHOP = join(ROOT, 'test/fixtures/cli/bookshop');
const CALLS = join(ROOT, 'test/fixtures/extract/posthog-js/calls');
const BLOCKED = 'dashlint-test: network blocked';
// Written in two parts so this file does not match its own scan.
const RISKY_TRIGGER = 'pull_request' + '_target';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashlint-security-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Ran {
  code: number | null;
  out: string;
  err: string;
}

function blocked(args: string[], env: Record<string, string> = {}): Ran {
  const r = spawnSync(process.execPath, ['--import', HOOK, BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      NO_COLOR: '1',
      TMPDIR: dir,
      TEMP: dir,
      TMP: dir,
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The built binary with the network open, so a local server can answer `pull`. */
function open(args: string[], env: Record<string, string>): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: dir,
      env: { PATH: process.env['PATH'] ?? '', NO_COLOR: '1', TMPDIR: dir, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function sourcesConfig(extra = ''): void {
  cpSync(CALLS, dir, { recursive: true });
  cpSync(join(BOOKSHOP, 'requirements.json'), join(dir, 'requirements.json'));
  writeFileSync(
    join(dir, 'dashlint.config.yml'),
    `version: 1
requirements: requirements.json
sources:
  - name: web
    path: src
    platform: web
failOn: never
${extra}`,
  );
}

describe('offline commands with every socket blocked (G4)', { timeout: 60_000 }, () => {
  it('the hook bites: a fetch under it fails and says so (positive control)', () => {
    const r = spawnSync(
      process.execPath,
      ['--import', HOOK, '--input-type=module', '-e', "await fetch('https://example.com')"],
      { encoding: 'utf8' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(BLOCKED);
  });

  it('extract writes its catalog without the network', () => {
    sourcesConfig();
    const r = blocked(['extract', '--cwd', dir]);
    expect(r.err).not.toContain(BLOCKED);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/extract: wrote .*web\.catalog\.json/);
  });

  it('check, in every format, runs without the network even with a key configured', () => {
    sourcesConfig(`platforms:
  posthog:
    host: https://us.posthog.com
    project: 12345
    key: env:BOOKSHOP_POSTHOG_KEY
`);
    for (const format of ['text', 'json', 'html']) {
      const r = blocked(['check', '--cwd', dir, '--format', format], {
        BOOKSHOP_POSTHOG_KEY: 'phx_security_offline_only',
      });
      expect(`${r.out}${r.err}`, format).not.toContain(BLOCKED);
      expect(r.code, `${format}: ${r.err}`).toBe(0);
      expect(`${r.out}${r.err}`, format).not.toContain('phx_security_offline_only');
    }
  });

  it('check from catalog files runs without the network', () => {
    const r = blocked([
      'check',
      '--requirements',
      join(BOOKSHOP, 'requirements.json'),
      '--catalog',
      join(BOOKSHOP, 'web.catalog.json'),
      '--catalog',
      join(BOOKSHOP, 'mobile.catalog.json'),
      '--fail-on',
      'never',
    ]);
    expect(r.err).not.toContain(BLOCKED);
    expect(r.code).toBe(0);
  });

  it('audit --offline runs without the network', () => {
    sourcesConfig(`platforms:
  posthog:
    host: https://us.posthog.com
    project: 12345
    key: env:BOOKSHOP_POSTHOG_KEY
`);
    const r = blocked(['audit', '--offline', '--cwd', dir, '--quiet']);
    expect(r.err).not.toContain(BLOCKED);
    expect(r.code).toBe(0);
  });
});

// A local PostHog stand-in. `echo` answers every request with HTTP 401 whose detail repeats the
// Authorization header, the worst case for a message built from the response.
function server(mode: 'ok' | 'echo'): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const s: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'echo') {
        res.statusCode = 401;
        res.end(JSON.stringify({ detail: `bad key ${req.headers.authorization ?? ''}` }));
        return;
      }
      res.end(JSON.stringify({ next: null, results: [] }));
    });
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => s.close(() => done())),
      });
    });
  });
}

describe('the PostHog key never reaches an output stream (G12)', { timeout: 60_000 }, () => {
  const KEY = 'phx_security_debug_key_7d1c';

  function pullConfig(host: string): void {
    writeFileSync(
      join(dir, 'dashlint.config.yml'),
      `version: 1
requirements: dashlint.requirements.json
platforms:
  posthog:
    host: ${host}
    project: 12345
    key: env:BOOKSHOP_POSTHOG_KEY
`,
    );
  }

  it('DASHLINT_DEBUG turns debug on; empty and 0 leave it off', () => {
    expect(debugOn({ DASHLINT_DEBUG: '1' })).toBe(true);
    expect(debugOn({ DASHLINT_DEBUG: 'yes' })).toBe(true);
    expect(debugOn({ DASHLINT_DEBUG: '' })).toBe(false);
    expect(debugOn({ DASHLINT_DEBUG: '0' })).toBe(false);
    expect(debugOn({})).toBe(false);
  });

  it('a pull at debug level: stdout, stderr and the written file hold no key', async () => {
    const mock = await server('ok');
    try {
      pullConfig(mock.url);
      const r = await open(['pull', '--cwd', dir], {
        BOOKSHOP_POSTHOG_KEY: KEY,
        DASHLINT_DEBUG: '1',
      });
      expect(r.code, r.err).toBe(0);
      // Debug was really on: the request headers were printed, with the key replaced.
      expect(r.err).toContain('debug: GET ');
      expect(r.err).toContain('"Authorization":"Bearer [redacted]"');
      const written = readFileSync(join(dir, 'dashlint.requirements.json'), 'utf8');
      expect(r.out).not.toContain(KEY);
      expect(r.err).not.toContain(KEY);
      expect(written).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it('a pull the server refuses with the key in its answer: exit 4, still no key', async () => {
    const mock = await server('echo');
    try {
      pullConfig(mock.url);
      const r = await open(['pull', '--cwd', dir], {
        BOOKSHOP_POSTHOG_KEY: KEY,
        DASHLINT_DEBUG: '1',
      });
      expect(r.code).toBe(4);
      expect(r.err).toContain('[redacted]');
      expect(`${r.out}${r.err}`).not.toContain(KEY);
    } finally {
      await mock.close();
    }
  });

  it('a pull that cannot reach the host at debug level: no key', async () => {
    const mock = await server('ok');
    const url = mock.url;
    await mock.close();
    pullConfig(url);
    const r = await open(['pull', '--cwd', dir], {
      BOOKSHOP_POSTHOG_KEY: KEY,
      DASHLINT_DEBUG: '1',
    });
    expect(r.code).toBe(4);
    expect(`${r.out}${r.err}`).not.toContain(KEY);
  }, 60_000);
});

describe('YAML custom tags are refused wherever YAML is read', { timeout: 30_000 }, () => {
  it('only src/formats/yaml.ts parses with the yaml package, so every read takes the safe path', () => {
    // Listed from the filesystem, not `git ls-files`: Stryker runs the suite in an untracked
    // sandbox where git lists nothing, and an untracked new source file must count too.
    const files = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .map((f) => `src/${f.split(sep).join('/')}`)
      .filter((f) => f.endsWith('.ts'));
    expect(files).toContain('src/formats/yaml.ts');
    expect(files).toContain('src/formats/canonical.ts');
    const uses: Record<string, string[]> = {};
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      // Any other way to reach the package (namespace, default, require, dynamic import) counts
      // as a reader, since it could call parse.
      if (
        /import \* as \w+ from 'yaml'|import \w+(, \{[^}]*\})? from 'yaml'|require\('yaml'\)|import\('yaml'\)/.test(
          text,
        )
      )
        uses[f] = ['*'];
      for (const m of text.matchAll(/import \{([^}]*)\} from 'yaml'/g))
        uses[f] = [
          ...(uses[f] ?? []),
          ...(m[1] ?? '')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean),
        ];
    }
    const writeOnly = new Set(['stringify', 'type Document', 'type YAMLError']);
    const readers = Object.entries(uses)
      .filter(([, names]) => names.some((n) => !writeOnly.has(n)))
      .map(([f]) => f);
    expect(readers).toEqual(['src/formats/yaml.ts']);
    // canonical.ts writes YAML and reads none.
    expect(uses['src/formats/canonical.ts']).toEqual(['stringify']);
  });

  for (const [what, tagged] of [
    ['!!js/function', `!!js/function "function () { return 1; }"`],
    ['a local tag', `!bookshop "shelf"`],
    ['!!binary', `!!binary aGVsbG8=`],
  ] as const) {
    it(`a config with ${what} exits 2 naming the tag`, () => {
      sourcesConfig(`ignore:\n  - tile: ${tagged}\n`);
      const r = blocked(['check', '--cwd', dir]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/the tag \S+ is not allowed/);
    });
  }

  it('a requirements file with a custom tag exits 2 naming the tag', () => {
    sourcesConfig();
    writeFileSync(
      join(dir, 'requirements.yml'),
      `schema: dashlint.requirements/1\ntiles:\n  - id: t1\n    title: !!js/function "f"\n`,
    );
    const r = blocked([
      'check',
      '--requirements',
      join(dir, 'requirements.yml'),
      '--catalog',
      join(BOOKSHOP, 'web.catalog.json'),
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('the tag !!js/function is not allowed');
  });
});

/** Lines that use the risky trigger: code anywhere, and in Markdown only inside fenced blocks. */
function riskyTriggerLines(path: string, text: string): number[] {
  const hits: number[] = [];
  let fenced = false;
  text.split('\n').forEach((line, i) => {
    if (path.endsWith('.md') && /^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!line.includes(RISKY_TRIGGER)) return;
    if (!path.endsWith('.md') || fenced) hits.push(i + 1);
  });
  return hits;
}

describe('no risky workflow trigger anywhere', () => {
  it('the scan catches a workflow and a fenced README example (negative controls)', () => {
    expect(riskyTriggerLines('.github/workflows/x.yml', `on:\n  ${RISKY_TRIGGER}:\n`)).toEqual([2]);
    expect(
      riskyTriggerLines('README.md', `text\n\`\`\`yaml\non: ${RISKY_TRIGGER}\n\`\`\`\n`),
    ).toEqual([3]);
    expect(riskyTriggerLines('README.md', `It never uses \`${RISKY_TRIGGER}\`.\n`)).toEqual([]);
  });

  it('no tracked file uses it (workflows, action.yml, bundle, sources, examples)', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => f !== '');
    const found: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue; // a file deleted in the working tree
      }
      for (const line of riskyTriggerLines(f, text)) found.push(`${f}:${line}`);
    }
    expect(found).toEqual([]);
  });
});

describe('the npm tarball', { timeout: 60_000 }, () => {
  it('npm pack --dry-run lists only dist, descriptors, README, LICENSE and package.json', () => {
    const [cmd, pre] = npmCommand();
    const json = execFileSync(cmd, [...pre, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    const [pack] = JSON.parse(json) as [{ files: { path: string }[] }];
    const paths = pack.files.map((f) => f.path);
    const allowed = (p: string) =>
      p.startsWith('dist/') ||
      p.startsWith('descriptors/') ||
      ['README.md', 'LICENSE', 'package.json'].includes(p);
    expect(paths.filter((p) => !allowed(p))).toEqual([]);
    for (const p of ['README.md', 'LICENSE', 'package.json', 'dist/cli/main.js'])
      expect(paths).toContain(p);
    expect(paths.some((p) => p.startsWith('descriptors/'))).toBe(true);
    // The Action bundle ships in dashlint/action, not on npm.
    expect(paths).not.toContain('dist/action.mjs');
    expect(paths.some((p) => p.endsWith('.map') || p.includes('.env'))).toBe(false);
  });
});
