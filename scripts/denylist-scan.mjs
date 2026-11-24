#!/usr/bin/env node
// Clean-room scan (spec G1). Strict terms (case-insensitive substrings) block; review terms (whole
// words) are listed. Scans the working tree, `git log -p --all --format=fuller`, the contents of an
// `npm pack` tarball, the Action bundle (dist/action.mjs) and any directory given with --dir.
// Prints CLEAN or the hits with their location.
//
// The denylist is private and never enters this repo: it is read from --denylist <path> or
// DASHLINT_DENYLIST. With neither (as in CI) the scan is skipped and says so.
//
// Usage: node scripts/denylist-scan.mjs [--denylist <file>] [--review <file>] [--repo <dir>]
//          [--dir <dir>]... [--skip tree,history,pack,bundle]
// Exit: 0 CLEAN or skipped, 1 strict hits, 2 usage or I/O error.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SOURCES = ['tree', 'history', 'pack', 'bundle'];
const BUNDLE = 'dist/action.mjs';
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export function loadTerms(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeMatchers(strict, review) {
  const alt = (terms) => terms.map(esc).join('|');
  return {
    strict: strict.length ? new RegExp(alt(strict), 'gi') : null,
    review: review.length
      ? new RegExp(`(?<![A-Za-z0-9_])(?:${alt(review)})(?![A-Za-z0-9_])`, 'gi')
      : null,
  };
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// Hits in one text: { tier, line, term } with 1-based lines; locate(line) names the place.
export function scanText(text, matchers, locate) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const tier of ['strict', 'review']) {
      const re = matchers[tier];
      if (!re) continue;
      re.lastIndex = 0;
      for (const m of lines[i].matchAll(re)) hits.push({ tier, where: locate(i + 1), term: m[0] });
    }
  }
  return hits;
}

const slash = (p) => p.replace(/\\/g, '/');

/** The command and leading arguments that start npm: on Windows npm is a .cmd file, not a program. */
export const npmCommand = (platform = process.platform, node = process.execPath) =>
  platform === 'win32'
    ? [node, [join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')]]
    : ['npm', []];

const git = (repo, args) =>
  spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });

function scanFile(abs, label, matchers) {
  const buf = readFileSync(abs);
  if (isBinary(buf)) return [];
  return scanText(buf.toString('utf8'), matchers, (n) => `${label}:${n}`);
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}

function scanTree(repo, matchers) {
  const r = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (r.status !== 0) throw new Error(`git ls-files failed in ${repo}: ${r.stderr.trim()}`);
  const files = [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
  const hits = [];
  for (const f of files) {
    const abs = join(repo, f);
    if (existsSync(abs) && statSync(abs).isFile())
      hits.push(...scanFile(abs, `tree ${f}`, matchers));
  }
  return { hits, note: `${files.length} files` };
}

function scanHistory(repo, matchers) {
  const r = git(repo, ['log', '-p', '--all', '--format=fuller', '--no-color']);
  if (r.status !== 0) throw new Error(`git log failed in ${repo}: ${r.stderr.trim()}`);
  const lines = r.stdout.split('\n');
  const commitAt = [];
  let current = '?';
  let commits = 0;
  for (const l of lines) {
    const m = /^commit ([0-9a-f]{7,40})/.exec(l);
    if (m) {
      current = m[1].slice(0, 7);
      commits++;
    }
    commitAt.push(current);
  }
  const hits = scanText(
    r.stdout,
    matchers,
    (n) => `history commit ${commitAt[n - 1]} (log line ${n})`,
  );
  return { hits, note: `${commits} commits` };
}

// Minimal ustar reader for an npm pack tarball: yields { name, data } for regular files.
export function* untar(tgz) {
  const buf = gunzipSync(tgz);
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = field(156, 157) || '0';
    const prefix = field(345, 500);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === '0') yield { name, data };
  }
}

function scanPack(repo, matchers) {
  if (!existsSync(join(repo, 'package.json')))
    return { hits: [], note: 'no package.json, skipped' };
  const dest = mkdtempSync(join(tmpdir(), 'dashlint-scan-'));
  try {
    const [cmd, pre] = npmCommand();
    const r = spawnSync(
      cmd,
      [...pre, 'pack', '--json', '--ignore-scripts', '--pack-destination', dest],
      { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.status !== 0)
      throw new Error(`npm pack failed in ${repo}: ${r.stderr.trim().slice(-400)}`);
    const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error(`npm pack wrote no tarball in ${dest}`);
    const hits = [];
    let files = 0;
    for (const { name, data } of untar(readFileSync(join(dest, tgz)))) {
      files++;
      if (isBinary(data)) continue;
      hits.push(...scanText(data.toString('utf8'), matchers, (n) => `pack ${name}:${n}`));
    }
    return { hits, note: `${tgz}, ${files} files` };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

function scanBundle(repo, matchers) {
  const abs = join(repo, BUNDLE);
  if (!existsSync(abs)) return { hits: [], note: `${BUNDLE} not built, skipped` };
  return { hits: scanFile(abs, `bundle ${BUNDLE}`, matchers), note: BUNDLE };
}

function scanDir(dir, matchers) {
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(`--dir ${dir} is not a directory`);
  const files = walk(dir);
  const hits = [];
  for (const f of files)
    hits.push(...scanFile(f, `dir ${slash(relative(process.cwd(), f) || f)}`, matchers));
  return { hits, note: `${files.length} files` };
}

export function parseArgs(argv, env) {
  const opts = {
    denylist: env.DASHLINT_DENYLIST || null,
    review: null,
    repo: '.',
    dirs: [],
    skip: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--denylist') opts.denylist = val();
    else if (a === '--review') opts.review = val();
    else if (a === '--repo') opts.repo = val();
    else if (a === '--dir') opts.dirs.push(val());
    else if (a === '--skip') opts.skip.push(...val().split(',').filter(Boolean));
    else throw new Error(`unknown argument ${a}`);
  }
  for (const s of opts.skip)
    if (!SOURCES.includes(s))
      throw new Error(`--skip: unknown source "${s}" (${SOURCES.join(', ')})`);
  return opts;
}

// Returns { code, out } so tests can run it in process.
export function run(argv, env = process.env) {
  const out = [];
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    return { code: 2, out: [`denylist-scan: ${e.message}`] };
  }
  if (!opts.denylist) {
    return {
      code: 0,
      out: [
        'SKIPPED: no denylist given (--denylist or DASHLINT_DENYLIST); the clean-room scan runs only where the private list is',
      ],
    };
  }
  try {
    const strict = loadTerms(opts.denylist);
    if (!strict.length) throw new Error(`the denylist ${opts.denylist} has no terms`);
    const reviewPath = opts.review ?? join(dirname(opts.denylist), 'denylist-review.txt');
    const review = opts.review || existsSync(reviewPath) ? loadTerms(reviewPath) : [];
    // An explicit --review that is missing throws in loadTerms; the sibling file is optional.
    const matchers = makeMatchers(strict, review);
    const repo = resolve(opts.repo);
    const scanners = { tree: scanTree, history: scanHistory, pack: scanPack, bundle: scanBundle };
    const all = [];
    for (const s of SOURCES) {
      if (opts.skip.includes(s)) {
        out.push(`${s}: skipped (--skip)`);
        continue;
      }
      const { hits, note } = scanners[s](repo, matchers);
      out.push(`${s}: ${note}`);
      all.push(...hits);
    }
    for (const d of opts.dirs) {
      const { hits, note } = scanDir(resolve(d), matchers);
      out.push(`dir ${d}: ${note}`);
      all.push(...hits);
    }
    out.push(`terms: ${strict.length} strict, ${review.length} review`);
    for (const h of all)
      out.push(`${h.tier === 'strict' ? 'STRICT' : 'REVIEW'} ${h.where}: ${h.term}`);
    const nStrict = all.filter((h) => h.tier === 'strict').length;
    const nReview = all.length - nStrict;
    if (nStrict) {
      out.push(`HITS: ${nStrict} strict, ${nReview} review`);
      return { code: 1, out };
    }
    out.push(nReview ? `CLEAN (${nReview} review-tier hits listed above, not blocking)` : 'CLEAN');
    return { code: 0, out };
  } catch (e) {
    out.push(`denylist-scan: ${e.message}`);
    return { code: 2, out };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { code, out } = run(process.argv.slice(2));
  process.stdout.write(`${out.join('\n')}\n`);
  process.exitCode = code;
}
