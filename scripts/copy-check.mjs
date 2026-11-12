#!/usr/bin/env node
// Copy check (spec G7, G11, §6.9.7):
//  - no em dash (U+2014) or en dash (U+2013) in any tracked text file;
//  - none in src/report/messages.ts, written as the character or as a \u escape;
//  - README.md carries the G11 sentences (the disclaimer and the closing sentence);
//  - src/report/messages.ts carries the closing sentence every report ends with.
//
// Usage: node scripts/copy-check.mjs [--repo <dir>]
// Exit: 0 PASS, 1 FAIL, 2 usage or I/O error.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DISCLAIMER =
  'Not affiliated with or endorsed by PostHog, Mixpanel, Amplitude or Twilio Segment.';
export const CLOSING =
  'A clean result means nothing dashlint can see is broken, not that every number is right.';
const MESSAGES = 'src/report/messages.ts';
const EN = String.fromCodePoint(0x2013);
const EM = String.fromCodePoint(0x2014);
const DASH = new RegExp(`[${EN}${EM}]`, 'g');
const DASH_ESCAPE = /\\u(?:201[34]|\{201[34]\})/gi;

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const squash = (s) => s.replace(/\s+/g, ' ');

// Positions of dashes in a text: { line, col, char } with 1-based numbers.
export function findDashes(text, re = DASH) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(re)) out.push({ line: i + 1, col: m.index + 1, char: m[0] });
  }
  return out;
}

const name = (c) => (c === EM ? 'em dash' : c === EN ? 'en dash' : `dash escape ${c}`);

export function check(repo) {
  const problems = [];
  const r = spawnSync(
    'git',
    ['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`git ls-files failed in ${repo}: ${r.stderr.trim()}`);
  const files = [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
  let scanned = 0;
  for (const f of files) {
    const abs = join(repo, f);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    scanned++;
    for (const d of findDashes(buf.toString('utf8'))) {
      problems.push(`${f}:${d.line}:${d.col}: ${name(d.char)} (G7)`);
    }
  }

  const readme = join(repo, 'README.md');
  if (!existsSync(readme)) problems.push('README.md is missing (G11)');
  else {
    const text = squash(readFileSync(readme, 'utf8'));
    if (!text.includes(DISCLAIMER))
      problems.push(`README.md lacks the disclaimer (G11): "${DISCLAIMER}"`);
    if (!text.includes(CLOSING))
      problems.push(`README.md lacks the closing sentence (G11): "${CLOSING}"`);
  }

  const messages = join(repo, MESSAGES);
  if (!existsSync(messages)) problems.push(`${MESSAGES} is missing (spec 6.9.7)`);
  else {
    const text = readFileSync(messages, 'utf8');
    for (const d of findDashes(text, DASH_ESCAPE)) {
      problems.push(`${MESSAGES}:${d.line}:${d.col}: ${name(d.char)} (G7)`);
    }
    if (!squash(text).includes(CLOSING)) {
      problems.push(`${MESSAGES} lacks the closing sentence (G11): "${CLOSING}"`);
    }
  }
  return { problems, scanned };
}

export function run(argv) {
  let repo = '.';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1] !== undefined) repo = argv[++i];
    else return { code: 2, out: [`copy-check: unknown or incomplete argument ${argv[i]}`] };
  }
  try {
    const { problems, scanned } = check(resolve(repo));
    const out = [`text files: ${scanned}`, ...problems];
    out.push(problems.length ? `FAIL: ${problems.length} problem(s)` : 'PASS');
    return { code: problems.length ? 1 : 0, out };
  } catch (e) {
    return { code: 2, out: [`copy-check: ${e.message}`] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { code, out } = run(process.argv.slice(2));
  process.stdout.write(`${out.join('\n')}\n`);
  process.exitCode = code;
}
