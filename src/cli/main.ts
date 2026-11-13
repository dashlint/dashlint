#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pullCommand } from './commands/pull.js';

export function readVersion(): string {
  const packageJsonUrl = new URL('../../package.json', import.meta.url);
  const packageJsonPath = fileURLToPath(packageJsonUrl);
  const contents = readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(contents) as { version: string };
  return parsed.version;
}

export const helpText = `dashlint

Usage: dashlint <command> [options]

Options:
  --version   print the version number
  --help      print this message
`;

export function run(argv: readonly string[]): string {
  if (argv.includes('--version')) {
    return readVersion();
  }
  return helpText;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `pull` only until T7.4 brings the full command set.
  if (argv[0] === 'pull') {
    process.exitCode = await pullCommand(argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      tool: readVersion(),
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    });
    return;
  }
  process.stdout.write(`${run(argv)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
