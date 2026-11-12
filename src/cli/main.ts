#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function main(): void {
  process.stdout.write(`${run(process.argv.slice(2))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
