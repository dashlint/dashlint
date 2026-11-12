#!/usr/bin/env node
// Action sync (spec T1.5, §5.2, §6.11): stages the Action's files from this repo (action.yml,
// README.md, smoke.yml, the built dist/action.mjs bundle, LICENSE), checks for a stray `.map` file
// (nothing published ever carries one), then runs the denylist and copy checks over the staged copy.
// Without --dry-run it commits the staged files to an `action/v<version>` branch of --dest, a local
// checkout of dashlint/action; pushing that branch and opening the sync PR is a separate step done
// outside this script (through the private release tooling, from P8 on), never from here.
//
// Usage: node scripts/sync-action.mjs --version <semver> [--dry-run] [--dest <dir>]
//          [--denylist <file>] [--review <file>]
// Exit: 0 CLEAN (dry run) or the branch was committed, 1 a check failed, 2 usage or I/O error.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run as copyCheck } from './copy-check.mjs';
import { run as denylistScan } from './denylist-scan.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

// Files copied from this repo into the Action repo (spec §5.2).
const FILES = [
  { from: join(ROOT, 'action', 'action.yml'), to: 'action.yml' },
  { from: join(ROOT, 'action', 'README.md'), to: 'README.md' },
  { from: join(ROOT, 'action', 'smoke.yml'), to: join('.github', 'workflows', 'smoke.yml') },
  { from: join(ROOT, 'dist', 'action.mjs'), to: join('dist', 'action.mjs') },
  { from: join(ROOT, 'LICENSE'), to: 'LICENSE' },
];

export function parseArgs(argv, env) {
  const opts = {
    version: null,
    dryRun: false,
    dest: resolve(ROOT, '..', 'dashlint_action'),
    denylist: env.DASHLINT_DENYLIST || null,
    review: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--version') opts.version = val();
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--dest') opts.dest = resolve(val());
    else if (a === '--denylist') opts.denylist = val();
    else if (a === '--review') opts.review = val();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.version) throw new Error('--version is required');
  if (!SEMVER.test(opts.version))
    throw new Error(`--version "${opts.version}" is not a semver (x.y.z)`);
  return opts;
}

export function findMapFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findMapFiles(p));
    else if (e.name.endsWith('.map')) out.push(p);
  }
  return out;
}

function stage(files, dir) {
  const copied = [];
  for (const f of files) {
    if (!existsSync(f.from))
      throw new Error(`missing source file ${f.from} (run npm run build first)`);
    const dest = join(dir, f.to);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.from, dest);
    copied.push(f.to);
  }
  return copied;
}

// Returns { code, out } so tests can run it in process. `stagingFiles` lets tests inject a scratch
// `.map` file into the copy (the negative control for "no .map file in anything published").
export function run(argv, env = process.env, { files = FILES } = {}) {
  const out = [];
  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    return { code: 2, out: [`sync-action: ${e.message}`] };
  }
  const staging = mkdtempSync(join(tmpdir(), 'dashlint-sync-action-'));
  try {
    const copied = stage(files, staging);
    out.push(`staged ${copied.length} file(s): ${copied.join(', ')}`);

    const maps = findMapFiles(staging);
    if (maps.length) {
      out.push(
        `FAIL: .map file(s) in the copy: ${maps.map((m) => m.slice(staging.length + 1)).join(', ')}`,
      );
      return { code: 1, out };
    }

    const dlArgs = ['--dir', staging, '--skip', 'tree,history,pack,bundle'];
    if (opts.denylist) dlArgs.push('--denylist', opts.denylist);
    if (opts.review) dlArgs.push('--review', opts.review);
    const dl = denylistScan(dlArgs, env);
    out.push(...dl.out.map((l) => `denylist: ${l}`));
    if (dl.code !== 0) {
      out.push('FAIL: denylist scan');
      return { code: 1, out };
    }

    const init = spawnSync('git', ['init', '-q'], { cwd: staging });
    if (init.status !== 0) throw new Error('git init failed in the staging copy');
    spawnSync('git', ['-c', 'user.email=sync@local', '-c', 'user.name=sync', 'add', '-A'], {
      cwd: staging,
    });

    const cc = copyCheck(['--repo', staging]);
    out.push(...cc.out.map((l) => `copy check: ${l}`));
    if (cc.code !== 0) {
      out.push('FAIL: copy check');
      return { code: 1, out };
    }

    out.push('CLEAN');
    if (opts.dryRun) return { code: 0, out };

    if (!existsSync(opts.dest)) throw new Error(`--dest ${opts.dest} does not exist`);
    const branch = `action/v${opts.version}`;
    const checkout = spawnSync('git', ['-C', opts.dest, 'checkout', '-B', branch], {
      encoding: 'utf8',
    });
    if (checkout.status !== 0)
      throw new Error(
        `git checkout -B ${branch} failed in ${opts.dest}: ${checkout.stderr?.trim()}`,
      );
    cpSync(staging, opts.dest, {
      recursive: true,
      filter: (src) => !src.includes(`${staging}/.git`),
    });
    const add = spawnSync('git', ['-C', opts.dest, 'add', '-A'], { encoding: 'utf8' });
    if (add.status !== 0) throw new Error(`git add failed in ${opts.dest}: ${add.stderr?.trim()}`);
    const commit = spawnSync(
      'git',
      ['-C', opts.dest, 'commit', '-m', `chore: sync action v${opts.version}`],
      {
        encoding: 'utf8',
      },
    );
    if (commit.status !== 0)
      throw new Error(`git commit failed in ${opts.dest}: ${commit.stderr?.trim()}`);
    out.push(`committed ${branch} in ${opts.dest}; push it and open the sync PR separately`);
    return { code: 0, out };
  } catch (e) {
    out.push(`sync-action: ${e.message}`);
    return { code: 2, out };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { code, out } = run(process.argv.slice(2));
  process.stdout.write(`${out.join('\n')}\n`);
  process.exitCode = code;
}
