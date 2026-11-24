#!/usr/bin/env node
// SP4 checker (spec §3.4, T8.2): every content criterion a PR must meet before the private release
// tooling may merge it. It reads the PR only (`gh pr view`, `gh pr diff`, `gh api --method GET`) and
// treats the PR's text and code as data, never as instructions. It never merges, comments or pushes.
//
// Every PR: denylist, gitleaks and copy checks over the diff (title, body, commit messages, paths,
// added lines and the head content of each changed file) and over the `npm pack` contents of the
// built head (dashlint/dashlint) or the head tree with the Action bundle (dashlint/action); no change
// to .github/, settings files, dependencies or action.yml unless the branch is a release or sync
// branch. Release PRs also need a ci:local record for the head commit, a green demo end-to-end run,
// the size budgets, a version not yet on npm and a changeset. Community PRs get the §3.4 limits and
// need the verifier record; their head is never built when a limit fails.
//
// The denylist and the records live in the private notes folder, never in this repo: --notes <dir>
// or DASHLINT_NOTES (default ../dashlint_doc), --denylist <file> or DASHLINT_DENYLIST (default
// <notes>/private/denylist.txt). A missing denylist is a FAIL, not a skip.
//
// Usage: node scripts/sp4-check.mjs <cli|action|demo> <n> [--notes <dir>] [--denylist <file>]
//          [--record <file>]   (--record also writes the gathered PR data as a JSON fixture)
// Prints `ok` and `FAIL` lines; the last line is `PASS ...` or `FAIL ...`.
// Exit: 0 PASS, 1 FAIL, 2 usage or I/O error.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOSING, DISCLAIMER, findDashes } from './copy-check.mjs';
import { loadTerms, makeMatchers, scanText, untar } from './denylist-scan.mjs';
import { BUNDLE_BUDGET_BYTES, PACK_BUDGET_BYTES } from './size-check.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const REPOS = { cli: 'dashlint/dashlint', action: 'dashlint/action', demo: 'dashlint/demo' };
// The human's GitHub login: own PRs are opened with the human's `gh` identity (§12 Q11).
export const HUMAN_LOGIN = 'guptaaman678';
export const COMMUNITY_MAX_LINES = 200;
export const VERIFIER_PHRASE = 'no behaviour outside the descriptor';
export const DEMO_E2E_WORKFLOW = 'dashlint.yml';
const SEMVER = 'v(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)';
const DATE_SLUG = '\\d{4}-\\d{2}-\\d{2}(?:-[a-z0-9][a-z0-9-]*)?';
const DASH = new RegExp(`[${String.fromCodePoint(0x2013)}${String.fromCodePoint(0x2014)}]`, 'g');
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'overrides',
];
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);
const SETTINGS_FILES = new Set([
  'CODEOWNERS',
  '.gitleaks.toml',
  '.gitleaksignore',
  '.npmrc',
  '.nvmrc',
  '.gitattributes',
]);
const DOC_EXT = /\.(md|mdx|txt)$/i;
const DOC_ASSET = /^docs\/.+\.(md|mdx|txt|png|jpe?g|gif|svg|webp)$/i;
const SCAN_TEXT_LIMIT = 64 * 1024 * 1024;

/** The SP4 branch kind (§3.4 own PRs), as runner/pub-pr.mjs knows it; null when not allowed. */
export function branchKind(repo, branch) {
  const s = String(branch ?? '');
  if (repo === 'cli') {
    if (new RegExp(`^release/${SEMVER}$`).test(s)) return 'release';
    if (new RegExp(`^docs/${DATE_SLUG}$`).test(s)) return 'docs';
  }
  if (repo === 'action' && new RegExp(`^action/${SEMVER}$`).test(s)) return 'sync';
  if (repo === 'demo' && new RegExp(`^demo/${DATE_SLUG}$`).test(s)) return 'demo';
  return null;
}

export const branchVersion = (branch) =>
  new RegExp(`^(?:release|action)/${SEMVER}$`).exec(String(branch ?? ''))?.[1] ?? null;

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const changedPaths = (files) =>
  files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));

// --- path rules --------------------------------------------------------------------------------

export const isWorkflow = (p) => p.startsWith('.github/workflows/');
export const isSettings = (p) =>
  (p.startsWith('.github/') && !isWorkflow(p)) ||
  SETTINGS_FILES.has(basename(p)) ||
  p === '.changeset/config.json';
export const isActionYml = (p) => /^(?:.*\/)?action\.ya?ml$/.test(p);
export const isLockfile = (p) => LOCKFILES.has(basename(p));
export const isDocPath = (p) =>
  (DOC_EXT.test(p) && !p.startsWith('.github/') && !p.startsWith('src/')) || DOC_ASSET.test(p);
export const isDescriptorData = (p) =>
  /^descriptors\/[^/]+\.ya?ml$/.test(p) || /^descriptors\/builtins\/[^/]+\.ya?ml$/.test(p);

/** The dependency fields of two package.json texts that differ (both may be null). */
export function dependencyChanges(baseText, headText) {
  const parse = (t) => {
    if (t == null) return {};
    try {
      return JSON.parse(t);
    } catch {
      return { __unparsable__: t };
    }
  };
  const a = parse(baseText);
  const b = parse(headText);
  const fields = [...DEP_FIELDS, '__unparsable__'];
  return fields.filter((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));
}

// --- the gh boundary ---------------------------------------------------------------------------

function realGh(args, { buffer = false } = {}) {
  const r = spawnSync('gh', args, {
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', GH_PAGER: '' },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: String(r.stderr ?? '') };
}

const PR_FIELDS =
  'number,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,author,isCrossRepository,title,body,commits,url';

/** Everything the checker reads from GitHub about PR <n>, as one JSON-able record (a fixture). */
export function gather(repo, n, gh = realGh) {
  const full = REPOS[repo];
  const json = (args, what) => {
    const r = gh(args);
    if (r.status !== 0)
      throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return JSON.parse(r.stdout);
  };
  const pr = json(['pr', 'view', String(n), '--repo', full, '--json', PR_FIELDS], 'gh pr view');
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = json(
      ['api', '--method', 'GET', `repos/${full}/pulls/${n}/files?per_page=100&page=${page}`],
      'gh api pulls files',
    );
    files.push(
      ...batch.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}),
      })),
    );
    if (batch.length < 100) break;
  }
  const d = gh(['pr', 'diff', String(n), '--repo', full]);
  const diff = d.status === 0 ? d.stdout : null;
  const diffNote = d.status === 0 ? '' : (d.stderr || d.stdout).trim().slice(0, 200);
  const base = {};
  for (const p of ['package.json', '.gitleaks.toml']) {
    const r = gh([
      'api',
      '--method',
      'GET',
      `repos/${full}/contents/${p}?ref=${pr.baseRefOid}`,
      '--jq',
      '.content',
    ]);
    base[p] = r.status === 0 ? Buffer.from(r.stdout.trim(), 'base64').toString('utf8') : null;
  }
  return { repo, number: Number(n), pr, files, diff, diffNote, base };
}

/** The demo end-to-end workflow's latest run (null when there is none). */
function realDemoRun(gh = realGh) {
  const r = gh([
    'api',
    '--method',
    'GET',
    `repos/${REPOS.demo}/actions/workflows/${DEMO_E2E_WORKFLOW}/runs?per_page=1`,
  ]);
  if (r.status !== 0) return null;
  const run = JSON.parse(r.stdout).workflow_runs?.[0];
  return run
    ? { status: run.status, conclusion: run.conclusion, sha: run.head_sha, url: run.html_url }
    : null;
}

/** The head commit's tree, from the repository tarball (a GET), extracted into a scratch dir. */
function realHeadTree(full, sha, scratch, gh = realGh) {
  const r = gh(['api', '--method', 'GET', `repos/${full}/tarball/${sha}`], { buffer: true });
  if (r.status !== 0) throw new Error(`gh api tarball failed: ${r.stderr.trim().slice(0, 300)}`);
  const tgz = join(scratch, 'head.tgz');
  writeFileSync(tgz, r.stdout);
  const dir = join(scratch, 'head');
  mkdirSync(dir);
  const x = spawnSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components', '1'], {
    encoding: 'utf8',
  });
  if (x.status !== 0) throw new Error(`tar failed: ${x.stderr.trim().slice(0, 300)}`);
  return dir;
}

/**
 * Builds the head of dashlint/dashlint and packs it. Reuses this checkout's node_modules when the
 * lockfiles are identical, else `npm ci --ignore-scripts`. Returns the pack's files, its size and
 * the Action bundle's size.
 */
function realBuildPack(dir, scratch) {
  const lock = (d) =>
    existsSync(join(d, 'package-lock.json')) ? readFileSync(join(d, 'package-lock.json')) : null;
  const sh = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0)
      throw new Error(
        `${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(-300)}`,
      );
    return r.stdout;
  };
  const mine = lock(ROOT);
  const theirs = lock(dir);
  if (mine && theirs && mine.equals(theirs) && existsSync(join(ROOT, 'node_modules')))
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  else sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  sh('npm', ['run', 'build']);
  const dest = join(scratch, 'pack');
  mkdirSync(dest);
  sh('npm', ['pack', '--ignore-scripts', '--pack-destination', dest]);
  const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack wrote no tarball');
  const files = [...untar(readFileSync(join(dest, tgz)))].map((f) => ({
    name: f.name.replace(/^package\//, ''),
    data: Buffer.from(f.data),
  }));
  const bundle = join(dir, 'dist', 'action.mjs');
  return {
    files,
    packBytes: statSync(join(dest, tgz)).size,
    bundleBytes: existsSync(bundle) ? statSync(bundle).size : null,
  };
}

/** gitleaks over a text (stdin) or a directory; `config` is the base branch's .gitleaks.toml. */
function realGitleaks(target, config, scratch) {
  const cwd = mkdtempSync(join(scratch, 'gl-'));
  const args = ['--no-banner', '--redact', '--exit-code', '1', '--log-level', 'error'];
  if (config != null) {
    writeFileSync(join(cwd, 'config.toml'), config);
    args.push('--config', join(cwd, 'config.toml'));
  }
  const r =
    'dir' in target
      ? spawnSync('gitleaks', ['dir', target.dir, ...args], { cwd, encoding: 'utf8' })
      : spawnSync('gitleaks', ['stdin', ...args], {
          cwd,
          input: target.text,
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
        });
  if (r.error) return { status: 2, out: `gitleaks could not run: ${r.error.message}` };
  return { status: r.status ?? 2, out: `${r.stdout}${r.stderr}`.trim().slice(0, 300) };
}

/** true on npm, false when npm answers 404, null when it cannot tell. */
function realNpmHasVersion(name, version) {
  const r = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    encoding: 'utf8',
  });
  if (r.status === 0) return r.stdout.trim() !== '' && r.stdout.trim() !== '[]';
  return /E404|404 Not Found/.test(`${r.stdout}${r.stderr}`) ? false : null;
}

export const realDeps = {
  gh: realGh,
  gather: (repo, n) => gather(repo, n, realGh),
  headTree: realHeadTree,
  buildPack: realBuildPack,
  gitleaks: realGitleaks,
  npmHasVersion: realNpmHasVersion,
  demoRun: () => realDemoRun(realGh),
};

// --- scanning ----------------------------------------------------------------------------------

/** The lines a diff adds, with the file each belongs to. */
export function addedLines(diff) {
  const out = [];
  let file = '?';
  for (const l of String(diff).split('\n')) {
    const m = /^\+\+\+ (?:b\/)?(.*)$/.exec(l);
    if (m) file = m[1];
    else if (l.startsWith('+') && !l.startsWith('+++')) out.push({ file, text: l.slice(1) });
  }
  return out;
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

// --- the checks --------------------------------------------------------------------------------

export function parseArgs(argv, env) {
  const [repo, n, ...rest] = argv;
  if (!REPOS[repo]) throw new Error(`repo must be one of ${Object.keys(REPOS).join(', ')}`);
  if (!/^\d+$/.test(n ?? '')) throw new Error('needs a PR number');
  const opts = {
    repo,
    n: Number(n),
    notes: env.DASHLINT_NOTES || resolve(ROOT, '..', 'dashlint_doc'),
    denylist: env.DASHLINT_DENYLIST || null,
    record: null,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const v = rest[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === '--notes') opts.notes = resolve(v);
    else if (a === '--denylist') opts.denylist = resolve(v);
    else if (a === '--record') opts.record = resolve(v);
    else throw new Error(`unknown argument ${a}`);
  }
  opts.denylist ??= join(opts.notes, 'private', 'denylist.txt');
  return opts;
}

/**
 * Runs every check over a gathered PR record. `deps` supplies the head tree, the build, gitleaks,
 * npm and the demo run (injected by the tests). Returns { code, out }.
 */
export function check(rec, opts, deps) {
  const out = [];
  const fail = (m) => out.push(`FAIL ${m}`);
  const ok = (m) => out.push(`ok   ${m}`);
  const { repo, pr, files } = rec;
  const full = REPOS[repo];
  const paths = changedPaths(files);

  // The PR itself.
  if (pr.state !== 'OPEN') fail(`PR is ${pr.state}, not OPEN`);
  if (pr.isDraft) fail('PR is a draft');
  if (pr.baseRefName !== 'main')
    fail(`PR is based on "${pr.baseRefName}", not main (no stacked PRs)`);
  if (!/^[0-9a-f]{40}$/.test(pr.headRefOid ?? '')) fail('PR has no head commit');
  const kind = branchKind(repo, pr.headRefName);
  const own = !pr.isCrossRepository && pr.author?.login === HUMAN_LOGIN;
  const runnerBranch = own && (kind === 'release' || kind === 'sync');
  if (own) {
    if (kind) ok(`own ${kind} PR from ${pr.headRefName}`);
    else fail(`own PR from "${pr.headRefName}", which is not an SP4 branch of ${full}`);
  } else
    ok(`community PR from ${pr.author?.login ?? 'unknown'} (${pr.headRefName}): §3.4 limits apply`);
  if (files.length === 0) fail('PR changes no files');

  // Protected paths: only the runner's release and sync branches may touch them.
  const guarded = [
    ['.github/workflows/', paths.filter(isWorkflow)],
    ['settings files', paths.filter(isSettings)],
    ['action.yml', paths.filter(isActionYml)],
    ['lockfiles', paths.filter(isLockfile)],
  ];
  const depFields = dependencyChanges(rec.base['package.json'], deps.readHead('package.json'));
  for (const [what, hits] of guarded) {
    if (!hits.length) continue;
    if (runnerBranch) ok(`${what} changed on a ${kind} branch: ${hits.slice(0, 5).join(', ')}`);
    else fail(`changes ${what} outside a release or sync branch: ${hits.slice(0, 5).join(', ')}`);
  }
  if (depFields.length) {
    if (runnerBranch) ok(`package.json ${depFields.join(', ')} changed on a ${kind} branch`);
    else fail(`changes package.json ${depFields.join(', ')} outside a release or sync branch`);
  }
  if (!guarded.some(([, h]) => h.length) && !depFields.length)
    ok('no change to workflows, settings, dependencies or action.yml');

  // Community limits (§3.4, §12 Q10).
  let communityOk = true;
  if (!own) {
    const before = out.length;
    const lines = files.reduce((s, f) => s + (f.additions ?? 0) + (f.deletions ?? 0), 0);
    if (lines > COMMUNITY_MAX_LINES)
      fail(`community PR changes ${lines} lines (limit ${COMMUNITY_MAX_LINES})`);
    const forbidden = paths.filter((p) => /^(src|scripts|\.github)\//.test(p));
    if (forbidden.length)
      fail(
        `community PR changes ${forbidden.slice(0, 5).join(', ')} (src/, scripts/ and .github/ are the human's)`,
      );
    const data = paths.filter(isDescriptorData);
    const allowed = (p) =>
      isDocPath(p) ||
      isDescriptorData(p) ||
      /^\.changeset\/[^/]+\.md$/.test(p) ||
      (data.length > 0 && p.startsWith('test/'));
    const other = paths.filter((p) => !allowed(p) && !/^(src|scripts|\.github)\//.test(p));
    if (other.length)
      fail(
        `community PR is neither docs-only nor descriptor data: ${other.slice(0, 5).join(', ')}`,
      );
    if (data.length) {
      if (!paths.some((p) => p.startsWith('test/fixtures/')))
        fail('descriptor data changes without a matching fixture under test/fixtures/');
      if (!paths.some((p) => p.startsWith('test/golden/') || /^test\/unit\/.+\.test\.ts$/.test(p)))
        fail('descriptor data changes without a matching golden or expectation under test/');
    }
    const recPath = join(opts.notes, 'launch', 'sp4-community', `${repo}-${rec.number}.md`);
    const text = existsSync(recPath) ? readFileSync(recPath, 'utf8') : '';
    if (!text) fail(`no verifier record ${recPath}`);
    else if (!text.includes(pr.headRefOid) || !text.toLowerCase().includes(VERIFIER_PHRASE))
      fail(
        `the verifier record must name head ${String(pr.headRefOid).slice(0, 12)} and say "${VERIFIER_PHRASE}"`,
      );
    communityOk = out.length === before;
    if (communityOk)
      ok(
        `community limits met (${lines} lines, ${data.length ? 'descriptor data' : 'docs only'}, verifier record)`,
      );
  }

  // Denylist, copy and gitleaks over the diff.
  let matchers = null;
  if (!existsSync(opts.denylist))
    fail(`no denylist at ${opts.denylist}; the clean-room check cannot run`);
  else {
    const strict = loadTerms(opts.denylist);
    if (!strict.length) fail(`the denylist ${opts.denylist} has no terms`);
    else matchers = makeMatchers(strict, []);
  }
  const texts = [
    { where: 'title', text: pr.title ?? '' },
    { where: 'body', text: pr.body ?? '' },
    ...(pr.commits ?? []).map((c) => ({
      where: `commit ${String(c.oid ?? '').slice(0, 7)}`,
      text: `${c.messageHeadline ?? ''}\n${c.messageBody ?? ''}`,
    })),
    { where: 'paths', text: paths.join('\n') },
  ];
  if (rec.diff != null)
    for (const a of addedLines(rec.diff)) texts.push({ where: `diff ${a.file}`, text: a.text });
  else
    ok(
      `gh pr diff unavailable (${rec.diffNote || 'no output'}); scanning the changed files at head`,
    );
  for (const f of files) {
    if (f.status === 'removed') continue;
    const buf = deps.readHeadBuffer(f.filename);
    if (buf && !isBinary(buf) && buf.length <= SCAN_TEXT_LIMIT)
      texts.push({ where: `head ${f.filename}`, text: buf.toString('utf8') });
  }
  scanTexts('diff', texts, matchers, ok, fail);
  const glText = texts.map((t) => t.text).join('\n');
  const gl = deps.gitleaks({ text: glText }, rec.base['.gitleaks.toml']);
  if (gl.status === 0) ok('gitleaks: diff clean');
  else if (gl.status === 1) fail('gitleaks: leak found in the diff');
  else fail(`gitleaks did not run on the diff: ${gl.out}`);

  // The published artefact: npm pack of the built head, or the Action repo's head tree.
  let built = null;
  if (repo === 'demo') ok('pack: the demo publishes no package or bundle');
  else if (!communityOk)
    fail('pack: not built, the community limits failed (an unchecked head is never run)');
  else {
    try {
      if (repo === 'cli') {
        built = deps.buildPack(deps.headDir);
        scanArtefact(
          `npm pack (${built.files.length} files)`,
          built.files,
          matchers,
          deps,
          rec,
          ok,
          fail,
        );
      } else {
        const names = walk(deps.headDir).filter(
          (p) => p !== '.gitleaks.toml' && p !== '.gitleaksignore',
        );
        const tree = names.map((name) => ({ name, data: readFileSync(join(deps.headDir, name)) }));
        const bundle = tree.find((f) => f.name === 'dist/action.mjs');
        built = { files: tree, bundleBytes: bundle ? bundle.data.length : null };
        scanArtefact(`action tree (${tree.length} files)`, tree, matchers, deps, rec, ok, fail);
      }
    } catch (e) {
      fail(`pack: ${e.message}`);
    }
  }

  // Release and sync PRs.
  if (own && kind === 'release') releaseChecks(rec, opts, deps, built, ok, fail);
  if (own && kind === 'sync') {
    if (built?.bundleBytes == null) fail('sync PR has no dist/action.mjs');
    else if (built.bundleBytes > BUNDLE_BUDGET_BYTES)
      fail(`action bundle ${built.bundleBytes} bytes, over the budget ${BUNDLE_BUDGET_BYTES}`);
    else ok(`action bundle ${built.bundleBytes} bytes (budget ${BUNDLE_BUDGET_BYTES})`);
  }

  const failed = out.filter((l) => l.startsWith('FAIL')).length;
  const label = `${full}#${rec.number}`;
  out.push(
    failed
      ? `FAIL sp4-check ${label}: ${failed} problem(s)`
      : `PASS sp4-check ${label} (${own ? kind : 'community'}, head ${pr.headRefOid.slice(0, 12)})`,
  );
  return { code: failed ? 1 : 0, out };
}

/** Denylist and dash hits over labelled texts; prints where, never the matched term. */
function scanTexts(label, texts, matchers, ok, fail) {
  let strict = 0;
  let dashes = 0;
  const where = new Set();
  for (const t of texts) {
    if (matchers) {
      const hits = scanText(t.text, matchers, (n) => `${t.where}:${n}`).filter(
        (h) => h.tier === 'strict',
      );
      strict += hits.length;
      for (const h of hits) where.add(h.where);
    }
    for (const d of findDashes(t.text, DASH)) {
      dashes++;
      where.add(`${t.where}:${d.line}:${d.col} dash`);
    }
  }
  const at = [...where].slice(0, 5).join(', ');
  if (matchers) {
    if (strict) fail(`denylist: ${strict} strict hit(s) in the ${label} at ${at}`);
    else ok(`denylist: ${label} clean`);
  }
  if (dashes) fail(`copy: ${dashes} em or en dash(es) in the ${label} at ${at}`);
  else ok(`copy: no em or en dash in the ${label}`);
}

function scanArtefact(label, files, matchers, deps, rec, ok, fail) {
  const texts = files
    .filter((f) => !isBinary(f.data))
    .map((f) => ({ where: f.name, text: f.data.toString('utf8') }));
  scanTexts(label, texts, matchers, ok, fail);
  const maps = files.filter((f) => f.name.endsWith('.map')).map((f) => f.name);
  if (maps.length) fail(`${label}: .map file(s) ${maps.slice(0, 5).join(', ')}`);
  else ok(`${label}: no .map file`);
  const readme = files.find((f) => f.name === 'README.md');
  const squashed = readme ? readme.data.toString('utf8').replace(/\s+/g, ' ') : '';
  if (!readme) fail(`${label}: no README.md`);
  else if (!squashed.includes(DISCLAIMER) || !squashed.includes(CLOSING))
    fail(`${label}: README.md lacks the disclaimer or the closing sentence (G11)`);
  else ok(`${label}: README.md carries the disclaimer and the closing sentence`);
  const gl = deps.gitleaks({ files }, rec.base['.gitleaks.toml']);
  if (gl.status === 0) ok(`gitleaks: ${label} clean`);
  else if (gl.status === 1) fail(`gitleaks: leak found in the ${label}`);
  else fail(`gitleaks did not run on the ${label}: ${gl.out}`);
}

function releaseChecks(rec, opts, deps, built, ok, fail) {
  const { pr } = rec;
  const sha = pr.headRefOid;
  const ci = join(opts.notes, 'verify', 'ci-local', `${sha}.txt`);
  const last = existsSync(ci)
    ? readFileSync(ci, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l.trim())
        .at(-1)
        ?.trim()
    : null;
  if (last === 'PASS') ok(`ci:local record for ${sha.slice(0, 12)} reads PASS`);
  else fail(`no ci:local PASS record at ${ci} for the head commit`);

  const run = deps.demoRun();
  if (!run) fail(`no ${DEMO_E2E_WORKFLOW} run in ${REPOS.demo} (the end-to-end run, T8.4)`);
  else if (run.status !== 'completed' || run.conclusion !== 'success')
    fail(
      `latest ${REPOS.demo} end-to-end run is ${run.status}/${run.conclusion ?? '-'} (${run.url ?? ''})`,
    );
  else ok(`latest ${REPOS.demo} end-to-end run green (${run.url ?? run.sha})`);

  if (built?.packBytes == null || built.bundleBytes == null) fail('size: the head was not built');
  else if (built.packBytes > PACK_BUDGET_BYTES || built.bundleBytes > BUNDLE_BUDGET_BYTES)
    fail(
      `size: pack ${built.packBytes}/${PACK_BUDGET_BYTES}, bundle ${built.bundleBytes}/${BUNDLE_BUDGET_BYTES} bytes, over budget`,
    );
  else
    ok(
      `size: pack ${built.packBytes}/${PACK_BUDGET_BYTES}, bundle ${built.bundleBytes}/${BUNDLE_BUDGET_BYTES} bytes`,
    );

  const version = branchVersion(pr.headRefName);
  let name = null;
  try {
    name = JSON.parse(deps.readHead('package.json') ?? 'null')?.name ?? null;
  } catch {
    name = null;
  }
  if (!name) fail('the head has no readable package.json name');
  else {
    const has = deps.npmHasVersion(name, version);
    if (has === false) ok(`${name}@${version} is not on npm yet`);
    else if (has === true) fail(`${name}@${version} is already on npm`);
    else fail(`could not tell whether ${name}@${version} is on npm`);
  }

  const changesets =
    deps.headDir && existsSync(join(deps.headDir, '.changeset'))
      ? readdirSync(join(deps.headDir, '.changeset')).filter(
          (f) => f.endsWith('.md') && f !== 'README.md',
        )
      : [];
  if (changesets.length) ok(`changeset present: ${changesets.slice(0, 3).join(', ')}`);
  else fail('no changeset in .changeset/ at the head');
}

/** Real dependencies bound to one PR: the head tree lives in `scratch`. */
function headDeps(rec, scratch, base = realDeps) {
  let dir = null;
  const headDir = () => (dir ??= base.headTree(REPOS[rec.repo], rec.pr.headRefOid, scratch));
  const readHeadBuffer = (p) => {
    const abs = join(headDir(), p);
    return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs) : null;
  };
  return {
    get headDir() {
      return headDir();
    },
    readHeadBuffer,
    readHead: (p) => readHeadBuffer(p)?.toString('utf8') ?? null,
    buildPack: (d) => base.buildPack(d, scratch),
    gitleaks: (target, config) => {
      if (!('files' in target)) return base.gitleaks(target, config, scratch);
      const d = mkdtempSync(join(scratch, 'artefact-'));
      for (const f of target.files) {
        mkdirSync(dirname(join(d, f.name)), { recursive: true });
        writeFileSync(join(d, f.name), f.data);
      }
      return base.gitleaks({ dir: d }, config, scratch);
    },
    npmHasVersion: base.npmHasVersion,
    demoRun: base.demoRun,
  };
}

export function run(argv, env = process.env, base = realDeps) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    return { code: 2, out: [`sp4-check: ${e.message}`, 'FAIL sp4-check: usage'] };
  }
  const scratch = mkdtempSync(join(tmpdir(), 'dashlint-sp4-'));
  try {
    const rec = base.gather(opts.repo, opts.n);
    if (opts.record) writeFileSync(opts.record, `${JSON.stringify(rec, null, 2)}\n`);
    return check(rec, opts, headDeps(rec, scratch, base));
  } catch (e) {
    return {
      code: 2,
      out: [
        `sp4-check: ${e.message}`,
        `FAIL sp4-check ${REPOS[opts.repo]}#${opts.n}: could not check`,
      ],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { code, out } = run(process.argv.slice(2));
  process.stdout.write(`${out.join('\n')}\n`);
  process.exitCode = code;
}
