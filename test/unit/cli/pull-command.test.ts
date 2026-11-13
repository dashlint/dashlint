// `dashlint pull` as a command (T5.5): the config it reads, the file it writes, what it says.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePullArgs, pullCommand } from '../../../src/cli/commands/pull.js';
import { pullMessages } from '../../../src/report/messages.js';

const KEY = 'phx_command_test_only';
const LITERAL_KEY_SENTENCE = 'Put the key in an environment variable and write `key: env:NAME`.';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashlint-pull-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// An empty project: every list is empty.
const emptyProject = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  expect(init?.method).toBe('GET');
  expect(String(url)).toMatch(/^https:\/\/us\.posthog\.com\/api\/projects\/12345\//);
  return new Response(JSON.stringify({ next: null, results: [] }), { status: 200 });
};

async function run(
  config: string | undefined,
  { env = { DASHLINT_POSTHOG_KEY: KEY }, args = [] as string[], fetch = emptyProject } = {},
) {
  if (config !== undefined) writeFileSync(join(dir, 'dashlint.config.yml'), config);
  const out: string[] = [];
  const err: string[] = [];
  const code = await pullCommand(args, {
    cwd: dir,
    env,
    tool: '0.0.0-test',
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    now: () => Date.parse('2026-11-13T10:00:00Z'),
    sleep: async () => {},
    fetch,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const CONFIG = `version: 1
requirements: dashlint.requirements.json
platforms:
  posthog:
    host: https://us.posthog.com
    project: 12345
    key: env:DASHLINT_POSTHOG_KEY
`;

describe('dashlint pull', () => {
  it('writes the requirements next to the config and says names become public on a public repo', async () => {
    const r = await run(CONFIG);
    expect(r.code).toBe(0);
    const file = join(dir, 'dashlint.requirements.json');
    const text = readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      schema: 'dashlint.requirements/1',
      source: { project: 12345, pulledAt: '2026-11-13T10:00:00Z', tool: '0.0.0-test' },
      tiles: [],
    });
    expect(r.out).toBe(pullMessages.wrote(file, 0, 0, 0));
    expect(r.err).toContain('pull: reading definitions from https://us.posthog.com, project 12345');
    expect(r.err).toContain(pullMessages.publicNames);
    expect(pullMessages.publicNames).toMatch(/public repository, they become public/);
    expect(`${r.out}${r.err}${text}`).not.toContain(KEY);
  });

  it('with redact: true says what was left out instead', async () => {
    const r = await run(`${CONFIG}    redact: true\n`);
    expect(r.code).toBe(0);
    expect(r.err).toContain(pullMessages.redacted);
    expect(r.err).not.toContain(pullMessages.publicNames);
  });

  it('hogql: true turns the recency opt-in on; without it the pull says GET only', async () => {
    const on = await run(`${CONFIG}    hogql: true\n`);
    expect(on.code).toBe(0);
    expect(on.err).toContain('project 12345 (GET only, and POST query/ for HogQL recency)');
    for (const config of [CONFIG, `${CONFIG}    hogql: false\n`]) {
      const off = await run(config);
      expect(off.code).toBe(0);
      expect(off.err).toContain('project 12345 (GET only)');
    }
  });

  it('negative control: a literal key is refused with exit 2 and the 6.8 sentence, before any request', async () => {
    let asked = 0;
    const r = await run(CONFIG.replace('env:DASHLINT_POSTHOG_KEY', KEY), {
      fetch: async () => {
        asked++;
        return new Response('{}');
      },
    });
    expect(r.code).toBe(2);
    expect(r.err).toBe(`dashlint pull: ${LITERAL_KEY_SENTENCE}`);
    expect(r.err).not.toContain(KEY);
    expect(asked).toBe(0);
    const numeric = await run(CONFIG.replace('env:DASHLINT_POSTHOG_KEY', '12345'));
    expect(numeric.code).toBe(2);
    expect(numeric.err).toContain(LITERAL_KEY_SENTENCE);
  });

  it('an unset key variable is exit 4, naming the variable', async () => {
    const r = await run(CONFIG, { env: {} });
    expect(r.code).toBe(4);
    expect(r.err).toContain('DASHLINT_POSTHOG_KEY is not set or empty');
  });

  it.each([
    ['no platforms', 'version: 1\n', 'platforms.posthog is missing'],
    ['platforms not a mapping', 'platforms: 3\n', 'platforms must be a mapping'],
    [
      'posthog not a mapping',
      'platforms:\n  posthog: [1]\n',
      'platforms.posthog must be a mapping',
    ],
    ['no host', CONFIG.replace(/ {4}host:.*\n/, ''), 'platforms.posthog.host is missing'],
    ['no project', CONFIG.replace(/ {4}project:.*\n/, ''), 'platforms.posthog.project is missing'],
    ['no key', CONFIG.replace(/ {4}key:.*\n/, ''), 'platforms.posthog.key is missing'],
    [
      'host not text',
      CONFIG.replace('host: https://us.posthog.com', 'host: 7'),
      'host must be a URL',
    ],
    ['host not a URL', CONFIG.replace('https://us.posthog.com', 'not a url'), 'host is not a URL'],
    ['project a name', CONFIG.replace('12345', 'bookshop'), 'must be the numeric project id'],
    ['project a list', CONFIG.replace('12345', '[1]'), 'must be the numeric project id'],
    ['observedDays 0', `${CONFIG}    observedDays: 0\n`, 'observedDays must be a whole number'],
    ['observedDays 1.5', `${CONFIG}    observedDays: 1.5\n`, 'observedDays must be a whole number'],
    ['redact text', `${CONFIG}    redact: "yes"\n`, 'redact must be true or false'],
    ['hogql text', `${CONFIG}    hogql: "yes"\n`, 'hogql must be true or false'],
    [
      'yaml requirements',
      CONFIG.replace('requirements.json', 'requirements.yml'),
      'pull writes JSON only',
    ],
    [
      'empty requirements',
      CONFIG.replace('dashlint.requirements.json', '""'),
      'requirements must be a file name',
    ],
    ['not a mapping', '- 1\n', 'the config must be a mapping'],
    ['a custom tag', `${CONFIG}x: !foo bar\n`, 'dashlint.config.yml: '],
  ])('config error (%s) is exit 2', async (_label, config, message) => {
    const r = await run(config);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });

  it('a missing config file is exit 2 naming it', async () => {
    const r = await run(undefined);
    expect(r.code).toBe(2);
    expect(r.err).toContain('cannot read the config');
    expect(r.err).toContain('dashlint.config.yml');
  });

  it('reads --config, relative to the working directory; the requirements path is relative to the config', async () => {
    writeFileSync(
      join(dir, 'other.yml'),
      CONFIG.replace('dashlint.requirements.json', 'snap.json'),
    );
    const r = await run(undefined, { args: ['--config', 'other.yml'] });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'snap.json'), 'utf8'))).toHaveProperty('tiles');
  });

  it('a failed request is exit 4; an unwritable output is exit 4; an unexpected error is exit 3', async () => {
    const denied = await run(CONFIG, {
      fetch: async () => new Response('{"detail":"Invalid token"}', { status: 401 }),
    });
    expect(denied.code).toBe(4);
    expect(denied.err).toContain('PostHog refused the key');
    const unwritable = await run(
      CONFIG.replace('dashlint.requirements.json', 'no/such/dir/r.json'),
    );
    expect(unwritable.code).toBe(4);
    expect(unwritable.err).toContain('cannot write');
    const bug = await run(CONFIG, {
      fetch: async () => {
        throw 'not an Error';
      },
    });
    // A thrown non-Error from fetch is a network failure the client reports (exit 4).
    expect(bug.code).toBe(4);
    const crash = await pullCommand([], {
      cwd: dir,
      env: { DASHLINT_POSTHOG_KEY: KEY },
      tool: '0.0.0-test',
      stdout: () => {
        throw new Error('stdout closed');
      },
      stderr: () => {},
      fetch: emptyProject,
    });
    expect(crash).toBe(3);
  });
});

describe('pull arguments', () => {
  it('takes --config and --out (spec 6.9.1), as <file> or =<file>, and nothing else', () => {
    expect(parsePullArgs([])).toEqual({ config: 'dashlint.config.yml' });
    expect(parsePullArgs(['--config', 'a.yml'])).toEqual({ config: 'a.yml' });
    expect(parsePullArgs(['--config=b.yml'])).toEqual({ config: 'b.yml' });
    expect(parsePullArgs(['--out', 'x.json'])).toEqual({
      config: 'dashlint.config.yml',
      out: 'x.json',
    });
    expect(() => parsePullArgs(['--config'])).toThrow(/--config needs a value/);
    expect(() => parsePullArgs(['--config', '--x'])).toThrow(/--config needs a value/);
    expect(() => parsePullArgs(['--config='])).toThrow(/--config needs a value/);
    expect(() => parsePullArgs(['--format', 'json'])).toThrow(/unknown option --format/);
    expect(() => parsePullArgs(['--catalog', 'x'])).toThrow(/unknown option --catalog/);
  });

  it('--out writes the requirements there, relative to the working directory, JSON only', async () => {
    const r = await run(CONFIG, { args: ['--out', 'snap.json'] });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'snap.json'), 'utf8'))).toHaveProperty('tiles');
    const yml = await run(CONFIG, { args: ['--out', 'snap.yml'] });
    expect(yml.code).toBe(2);
    expect(yml.err).toContain('pull writes JSON only');
  });

  it('negative control: an unknown config key is exit 2 naming it, before any request', async () => {
    let asked = 0;
    const r = await run(CONFIG.replace('    key:', '    keey:'), {
      fetch: async () => {
        asked++;
        return new Response('{}');
      },
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('platforms.posthog.keey is not a known key; did you mean `key`?');
    expect(asked).toBe(0);
  });
});
