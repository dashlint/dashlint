#!/usr/bin/env node
// Times one `dashlint check` run inside a warm process: the module import (node and TypeScript
// loading) apart from the command itself (read two catalogs and the requirements, check, write the
// report). Used by perf.mjs for the check budget; prints one JSON line.
// Usage: node scripts/perf-check-probe.mjs <dashlint check arguments...>
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const main = join(dirname(fileURLToPath(import.meta.url)), '../dist/cli/main.js');
const t0 = process.hrtime.bigint();
const { run } = await import(main);
const t1 = process.hrtime.bigint();
const lines = [];
const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (l) => lines.push(l),
  stderr: (l) => lines.push(l),
});
const t2 = process.hrtime.bigint();
process.stdout.write(
  `${JSON.stringify({ code, importSeconds: Number(t1 - t0) / 1e9, runSeconds: Number(t2 - t1) / 1e9 })}\n`,
);
