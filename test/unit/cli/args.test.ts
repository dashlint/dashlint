// The command line parser (spec 6.9.1): commands, flags, global flags and did-you-mean.
import { describe, expect, it } from 'vitest';
import { CliError, didYouMean, editDistance, parseArgs } from '../../../src/cli/args.js';

const fails = (argv: string[]): CliError => {
  try {
    parseArgs(argv);
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).exitCode).toBe(2);
    return e as CliError;
  }
  throw new Error(`parsed: ${argv.join(' ')}`);
};

describe('parseArgs', () => {
  it('reads the command, its flags and global flags in any order', () => {
    expect(
      parseArgs([
        '--quiet',
        'check',
        '--catalog',
        'a.json',
        '--catalog=b.json',
        '--format',
        'json',
        '--cwd',
        'x',
      ]),
    ).toEqual({
      command: 'check',
      globals: { cwd: 'x', quiet: true, noColor: false, version: false, help: false },
      flags: { catalog: ['a.json', 'b.json'], format: 'json' },
    });
    expect(parseArgs(['extract', '--source', 'web', '--no-color', '--config', 'c.yml'])).toEqual({
      command: 'extract',
      globals: { config: 'c.yml', quiet: false, noColor: true, version: false, help: false },
      flags: { source: 'web' },
    });
    expect(parseArgs(['pull', '--out', 'r.json']).flags).toEqual({ out: 'r.json' });
  });

  it('--version and --help win over everything else', () => {
    expect(parseArgs(['chek', '--version']).globals.version).toBe(true);
    expect(parseArgs(['--nope', '--help']).globals.help).toBe(true);
    expect(parseArgs(['-h']).globals.help).toBe(true);
  });

  it('a value that looks like a command is still the flag value', () => {
    expect(parseArgs(['extract', '--source', 'check'])).toMatchObject({
      command: 'extract',
      flags: { source: 'check' },
    });
  });

  it('negative controls: each mistake is exit 2 and names the problem', () => {
    expect(fails(['chek']).message).toBe('unknown command chek; did you mean check?');
    expect(fails(['frobnicate']).message).toBe('unknown command frobnicate');
    expect(fails(['check', 'extra']).message).toBe('unexpected argument extra');
    expect(fails(['check', '--fromat', 'json']).message).toBe(
      'unknown option --fromat; did you mean --format?',
    );
    expect(fails(['pull', '--format', 'json']).message).toBe('unknown option --format');
    expect(fails(['extract', '--catalog', 'x']).message).toMatch(/^unknown option --catalog/);
    expect(fails(['check', '--format']).message).toBe('--format needs a value');
    expect(fails(['check', '--out', '--quiet']).message).toBe('--out needs a value');
    expect(fails(['check', '--out=']).message).toBe('--out needs a value');
    expect(fails(['check', '--quiet=yes']).message).toBe('--quiet takes no value');
    expect(fails(['check', '--out', 'a', '--out', 'b']).message).toBe('--out is given twice');
    expect(fails(['check', '--format', 'pdf']).message).toBe(
      '--format pdf is not one of text, json, html, markdown',
    );
    expect(fails(['check', '--fail-on', 'all']).message).toBe(
      '--fail-on all is not one of dead, partly-dead, degraded, never',
    );
  });
});

describe('didYouMean', () => {
  it('suggests a close word and nothing for a far one', () => {
    expect(editDistance('keey', 'key')).toBe(1);
    expect(editDistance('fialOn', 'failOn')).toBe(1);
    expect(didYouMean('keey', ['host', 'project', 'key'])).toBe('key');
    expect(didYouMean('fialOn', ['failOn', 'ignore'])).toBe('failOn');
    expect(didYouMean('Sources', ['sources'])).toBe('sources');
    expect(didYouMean('colour', ['key', 'host'])).toBeUndefined();
    expect(didYouMean('x', [])).toBeUndefined();
  });
});
