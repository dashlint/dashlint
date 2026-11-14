import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSING, DISCLAIMER } from '../../../scripts/copy-check.mjs';
import { BUNDLE_BUDGET_BYTES, PACK_BUDGET_BYTES } from '../../../scripts/size-check.mjs';
import {
  addedLines,
  branchKind,
  check,
  dependencyChanges,
  gather,
  isDescriptorData,
  isSettings,
  run,
} from '../../../scripts/sp4-check.mjs';
import { EM_DASH, EN_DASH, writeFiles } from './helpers.js';

// The recorded PR (scripts/sp4-check.mjs cli 1 --record): an own docs PR adding one page.
const FIXTURE = join(import.meta.dirname, '../../fixtures/sp4/docs-pr.json');
const recorded = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
type Rec = ReturnType<typeof recorded>;
type FileEntry = { filename: string; status: string; additions: number; deletions: number };

const TERM = 'zebrafinch';
const LEAK = 'FAKE_LEAK_FOR_TESTS';
const README = `# dashlint\n\n${DISCLAIMER}\n\n${CLOSING}\n`;
const PAGE =
  '# SP4 checker test\n\nThis page exists only for the pull request that tests the merge checker.\n';

const dirs: string[] = [];
const scratch = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A notes folder with a scratch denylist (an invented term, never a real one).
function notes(extra: Record<string, string> = {}) {
  const dir = scratch('dashlint-sp4-notes-');
  writeFiles(dir, { 'private/denylist.txt': `# scratch\n${TERM}\n`, ...extra });
  return { notes: dir, denylist: join(dir, 'private/denylist.txt') };
}

type PackFile = { name: string; data: Buffer };
type Fakes = {
  tree?: Record<string, string>;
  pack?: Record<string, string>;
  packBytes?: number;
  bundleBytes?: number | null;
  npm?: boolean | null;
  demoRun?: { status: string; conclusion: string | null; sha: string; url: string } | null;
  gitleaksStatus?: number;
};

// Fake dependencies: the head tree on disk, a fake build, and a gitleaks that finds LEAK.
function deps(f: Fakes = {}) {
  const headDir = scratch('dashlint-sp4-head-');
  writeFiles(headDir, {
    'README.md': README,
    'package.json': recorded().base['package.json'],
    'docs/sp4-test.md': PAGE,
    ...f.tree,
  });
  const calls = { build: 0, gitleaks: 0 };
  const files = (m: Record<string, string>): PackFile[] =>
    Object.entries(m).map(([name, text]) => ({ name, data: Buffer.from(text) }));
  return {
    calls,
    headDir,
    readHeadBuffer: (p: string) =>
      existsSync(join(headDir, p)) ? readFileSync(join(headDir, p)) : null,
    readHead: (p: string) =>
      existsSync(join(headDir, p)) ? readFileSync(join(headDir, p), 'utf8') : null,
    buildPack: () => {
      calls.build++;
      return {
        files: files(f.pack ?? { 'README.md': README, 'dist/cli/main.js': 'export {};\n' }),
        packBytes: f.packBytes ?? 1000,
        bundleBytes: f.bundleBytes === undefined ? 2000 : f.bundleBytes,
      };
    },
    gitleaks: (target: { text?: string; files?: PackFile[] }) => {
      calls.gitleaks++;
      if (f.gitleaksStatus !== undefined) return { status: f.gitleaksStatus, out: 'boom' };
      const text = target.text ?? (target.files ?? []).map((x) => x.data.toString()).join('\n');
      return { status: text.includes(LEAK) ? 1 : 0, out: '' };
    },
    npmHasVersion: () => (f.npm === undefined ? false : f.npm),
    demoRun: () =>
      f.demoRun === undefined
        ? { status: 'completed', conclusion: 'success', sha: 'a'.repeat(40), url: 'run-1' }
        : f.demoRun,
  };
}

const last = (r: { out: string[] }) => r.out.at(-1) ?? '';
const fails = (r: { out: string[] }) => r.out.filter((l) => l.startsWith('FAIL ')).join('\n');

function withFiles(rec: Rec, files: FileEntry[], diff: string | null = null): Rec {
  return { ...rec, files, diff, diffNote: diff == null ? 'diff too large' : '' };
}
const diffFor = (path: string, added: string[]) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${added.length} @@\n${added
    .map((l) => `+${l}`)
    .join('\n')}\n`;
const file = (filename: string, additions = 1, deletions = 0): FileEntry => ({
  filename,
  status: 'modified',
  additions,
  deletions,
});

describe('sp4-check on the recorded docs PR', () => {
  it('passes, builds the pack once and runs gitleaks on the diff and the pack', () => {
    const d = deps();
    const r = check(recorded(), notes(), d);
    expect(fails(r)).toBe('');
    expect(r.code).toBe(0);
    expect(last(r)).toMatch(/^PASS sp4-check dashlint\/dashlint#1 \(docs, head 7bb1e9876e13\)$/);
    expect(d.calls).toEqual({ build: 1, gitleaks: 2 });
  });

  it('fails without a denylist instead of skipping', () => {
    const o = notes();
    rmSync(o.denylist);
    const r = check(recorded(), o, deps());
    expect(r.code).toBe(1);
    expect(fails(r)).toMatch(/no denylist at/);
  });
});

describe('protected paths', () => {
  it('a docs branch touching .github/workflows/ fails (negative control)', () => {
    const rec = withFiles(recorded(), [file('docs/sp4-test.md'), file('.github/workflows/ci.yml')]);
    const r = check(rec, notes(), deps({ tree: { '.github/workflows/ci.yml': 'name: ci\n' } }));
    expect(r.code).toBe(1);
    expect(fails(r)).toMatch(/changes \.github\/workflows\/ outside a release or sync branch/);
    expect(last(r)).toMatch(/^FAIL sp4-check/);
  });

  it('settings files, lockfiles and action.yml fail outside release and sync branches', () => {
    const rec = withFiles(recorded(), [
      file('.github/CODEOWNERS'),
      file('.gitleaks.toml'),
      file('package-lock.json'),
      file('action/action.yml'),
    ]);
    const out = fails(check(rec, notes(), deps()));
    expect(out).toMatch(/changes settings files .*\.github\/CODEOWNERS, \.gitleaks\.toml/);
    expect(out).toMatch(/changes lockfiles .*package-lock\.json/);
    expect(out).toMatch(/changes action\.yml .*action\/action\.yml/);
  });

  it('a dependency change in package.json fails on a docs branch', () => {
    const pkg = JSON.parse(recorded().base['package.json']);
    pkg.dependencies['left-pad'] = '1.3.0';
    const rec = withFiles(recorded(), [file('package.json')]);
    const r = check(rec, notes(), deps({ tree: { 'package.json': JSON.stringify(pkg) } }));
    expect(fails(r)).toMatch(/changes package\.json dependencies outside a release or sync branch/);
  });

  it('a version-only package.json change is not a dependency change', () => {
    const pkg = JSON.parse(recorded().base['package.json']);
    pkg.version = '0.1.0';
    expect(dependencyChanges(recorded().base['package.json'], JSON.stringify(pkg))).toEqual([]);
    pkg.devDependencies.vitest = '0.0.1';
    expect(dependencyChanges(recorded().base['package.json'], JSON.stringify(pkg))).toEqual([
      'devDependencies',
    ]);
    expect(dependencyChanges('{}', 'not json')).toEqual(['__unparsable__']);
  });

  it('classifies paths', () => {
    expect(isSettings('.github/ISSUE_TEMPLATE/bug.yml')).toBe(true);
    expect(isSettings('.changeset/config.json')).toBe(true);
    expect(isSettings('docs/a.md')).toBe(false);
    expect(isDescriptorData('descriptors/shelf.yml')).toBe(true);
    expect(isDescriptorData('descriptors/builtins/shelf.yml')).toBe(true);
    expect(isDescriptorData('descriptors/stubs/shelf.d.ts')).toBe(false);
  });
});

describe('denylist, copy and gitleaks over the diff', () => {
  it('a planted strict term in an added line fails and the term is not printed (negative control)', () => {
    const rec = withFiles(
      recorded(),
      [file('docs/sp4-test.md')],
      diffFor('docs/sp4-test.md', [`a ${TERM} sighting`]),
    );
    const r = check(rec, notes(), deps());
    expect(r.code).toBe(1);
    expect(fails(r)).toMatch(
      /denylist: \d+ strict hit\(s\) in the diff at diff docs\/sp4-test\.md:1/,
    );
    expect(r.out.join('\n')).not.toContain(TERM);
  });

  it('a strict term in the title or a commit message fails', () => {
    const rec = recorded();
    rec.title = `docs: ${TERM.toUpperCase()}`;
    rec.pr.title = rec.title;
    rec.pr.commits[0].messageBody = `about the ${TERM}`;
    const out = fails(check(rec, notes(), deps()));
    expect(out).toMatch(/strict hit\(s\) in the diff at title:1, commit 7bb1e98:2/);
  });

  it('when gh pr diff is unavailable the changed files are scanned at head', () => {
    const rec = withFiles(recorded(), [file('docs/sp4-test.md')], null);
    const r = check(rec, notes(), deps({ tree: { 'docs/sp4-test.md': `${PAGE}${TERM}\n` } }));
    expect(r.out.join('\n')).toMatch(/gh pr diff unavailable \(diff too large\)/);
    expect(fails(r)).toMatch(/strict hit\(s\) in the diff at head docs\/sp4-test\.md:4/);
  });

  it('an em dash in an added line or the PR body fails the copy check', () => {
    const rec = withFiles(
      recorded(),
      [file('docs/sp4-test.md')],
      diffFor('docs/sp4-test.md', [`a ${EM_DASH} b`]),
    );
    rec.pr.body = `body ${EM_DASH}`;
    const out = fails(check(rec, notes(), deps()));
    expect(out).toMatch(/copy: 2 em or en dash\(es\) in the diff/);
  });

  it('a gitleaks finding or a gitleaks that cannot run fails', () => {
    const rec = withFiles(
      recorded(),
      [file('docs/sp4-test.md')],
      diffFor('docs/sp4-test.md', [LEAK]),
    );
    expect(fails(check(rec, notes(), deps()))).toMatch(/gitleaks: leak found in the diff/);
    expect(fails(check(recorded(), notes(), deps({ gitleaksStatus: 2 })))).toMatch(
      /gitleaks did not run on the diff: boom/,
    );
  });
});

describe('the npm pack of the built head', () => {
  it('a strict term, a dash, a .map file or a leak in the pack fails', () => {
    const pack = {
      'README.md': README,
      'dist/cli/main.js': `// ${TERM} ${EM_DASH}\n${LEAK}\n`,
      'dist/cli/main.js.map': '{}',
    };
    const out = fails(check(recorded(), notes(), deps({ pack })));
    expect(out).toMatch(/denylist: 1 strict hit\(s\) in the npm pack \(3 files\)/);
    expect(out).toMatch(/copy: 1 em or en dash\(es\) in the npm pack/);
    expect(out).toMatch(/\.map file\(s\) dist\/cli\/main\.js\.map/);
    expect(out).toMatch(/gitleaks: leak found in the npm pack/);
  });

  it('a pack README without the G11 sentences fails', () => {
    const out = fails(check(recorded(), notes(), deps({ pack: { 'README.md': '# dashlint\n' } })));
    expect(out).toMatch(/README\.md lacks the disclaimer or the closing sentence/);
  });

  it('a build that throws fails the check', () => {
    const d = deps();
    d.buildPack = () => {
      throw new Error('npm run build failed');
    };
    expect(fails(check(recorded(), notes(), d))).toMatch(/pack: npm run build failed/);
  });
});

describe('own PRs', () => {
  it('an own PR from a branch SP4 does not know fails', () => {
    const rec = recorded();
    rec.pr.headRefName = 'feature/x';
    expect(fails(check(rec, notes(), deps()))).toMatch(/not an SP4 branch of dashlint\/dashlint/);
  });

  it('a closed, draft or stacked PR fails', () => {
    const rec = recorded();
    Object.assign(rec.pr, { state: 'CLOSED', isDraft: true, baseRefName: 'release/v0.1.0' });
    const out = fails(check(rec, notes(), deps()));
    expect(out).toMatch(/PR is CLOSED, not OPEN/);
    expect(out).toMatch(/PR is a draft/);
    expect(out).toMatch(/not main/);
  });

  it('knows the branch kinds of each repo', () => {
    expect(branchKind('cli', 'release/v0.1.0')).toBe('release');
    expect(branchKind('cli', 'docs/2026-11-14-sp4-test')).toBe('docs');
    expect(branchKind('cli', 'action/v0.1.0')).toBe(null);
    expect(branchKind('action', 'action/v0.1.0')).toBe('sync');
    expect(branchKind('demo', 'demo/2026-11-14-rename')).toBe('demo');
    expect(branchKind('demo', 'docs/2026-11-14')).toBe(null);
  });
});

describe('release PRs', () => {
  const SHA = '7bb1e9876e135f89dfa0adc53c4d819df5309fb0';
  const release = () => {
    const rec = withFiles(recorded(), [file('.changeset/brave-owls.md'), file('package.json')]);
    rec.pr.headRefName = 'release/v0.1.0';
    return rec;
  };
  const tree = { '.changeset/brave-owls.md': '---\n"dashlint": minor\n---\n\nFirst release.\n' };
  const ciRecord = { [`verify/ci-local/${SHA}.txt`]: 'ci:local summary:\n  PASS  build\nPASS\n' };

  it('passes with every release criterion met', () => {
    const r = check(release(), notes(ciRecord), deps({ tree }));
    expect(fails(r)).toBe('');
    expect(last(r)).toMatch(/^PASS sp4-check dashlint\/dashlint#1 \(release, /);
  });

  it('needs a ci:local PASS record for the head commit', () => {
    expect(fails(check(release(), notes(), deps({ tree })))).toMatch(/no ci:local PASS record/);
    const failing = { [`verify/ci-local/${SHA}.txt`]: 'PASS  build\nFAIL: 1 step(s)\n' };
    expect(fails(check(release(), notes(failing), deps({ tree })))).toMatch(
      /no ci:local PASS record/,
    );
  });

  it('needs a green demo end-to-end run', () => {
    expect(fails(check(release(), notes(ciRecord), deps({ tree, demoRun: null })))).toMatch(
      /no dashlint\.yml run in dashlint\/demo/,
    );
    const red = { status: 'completed', conclusion: 'failure', sha: SHA, url: 'run-2' };
    expect(fails(check(release(), notes(ciRecord), deps({ tree, demoRun: red })))).toMatch(
      /end-to-end run is completed\/failure/,
    );
  });

  it('needs the size budgets met', () => {
    const big = deps({ tree, packBytes: PACK_BUDGET_BYTES + 1 });
    expect(fails(check(release(), notes(ciRecord), big))).toMatch(/size: .* over budget/);
    const fat = deps({ tree, bundleBytes: BUNDLE_BUDGET_BYTES + 1 });
    expect(fails(check(release(), notes(ciRecord), fat))).toMatch(/size: .* over budget/);
  });

  it('needs the version not yet on npm, and an answer from npm', () => {
    expect(fails(check(release(), notes(ciRecord), deps({ tree, npm: true })))).toMatch(
      /dashlint@0\.1\.0 is already on npm/,
    );
    expect(fails(check(release(), notes(ciRecord), deps({ tree, npm: null })))).toMatch(
      /could not tell whether dashlint@0\.1\.0 is on npm/,
    );
  });

  it('needs a changeset at the head', () => {
    expect(fails(check(release(), notes(ciRecord), deps()))).toMatch(
      /no changeset in \.changeset\//,
    );
  });

  it('may change workflows and dependencies', () => {
    const rec = release();
    rec.files.push(file('.github/workflows/release.yml'), file('package-lock.json'));
    const r = check(rec, notes(ciRecord), deps({ tree }));
    expect(fails(r)).toBe('');
    expect(r.out.join('\n')).toMatch(/ok {3}\.github\/workflows\/ changed on a release branch/);
  });
});

describe('Action sync PRs', () => {
  const sync = () => {
    const rec = withFiles(
      { ...recorded(), repo: 'action' },
      [file('dist/action.mjs', 5000), file('action.yml'), file('.github/workflows/smoke.yml')],
      null,
    );
    rec.pr.headRefName = 'action/v0.0.1';
    return rec;
  };
  const tree = {
    'action.yml': 'name: dashlint\n',
    'dist/action.mjs': 'export {};\n',
    '.github/workflows/smoke.yml': 'name: smoke\n',
    LICENSE: 'MIT\n',
  };

  it('scans the head tree with the bundle and passes within budget', () => {
    const d = deps({ tree });
    const r = check(sync(), notes(), d);
    expect(fails(r)).toBe('');
    expect(r.out.join('\n')).toMatch(/action tree \(\d+ files\): no \.map file/);
    expect(d.calls.build).toBe(0);
    expect(last(r)).toMatch(/^PASS sp4-check dashlint\/action#1 \(sync, /);
  });

  it('a strict term in the bundle fails', () => {
    const r = check(sync(), notes(), deps({ tree: { ...tree, 'dist/action.mjs': `"${TERM}"\n` } }));
    expect(fails(r)).toMatch(/strict hit\(s\) in the (diff|action tree)/);
  });

  it('a missing bundle fails', () => {
    const d = deps({ tree });
    rmSync(join(d.headDir, 'dist/action.mjs'));
    expect(fails(check(sync(), notes(), d))).toMatch(/sync PR has no dist\/action\.mjs/);
  });
});

describe('community PRs', () => {
  const community = (files: FileEntry[]) => {
    const rec = withFiles(recorded(), files, null);
    rec.pr.author = { login: 'a-reader', is_bot: false };
    rec.pr.isCrossRepository = true;
    rec.pr.headRefName = 'patch-1';
    return rec;
  };
  const record = (sha = '7bb1e9876e135f89dfa0adc53c4d819df5309fb0') => ({
    'launch/sp4-community/cli-1.md': `Head ${sha}: docs only, no behaviour outside the descriptor.\n`,
  });

  it('a community PR changing src/ fails and its head is never built (negative control)', () => {
    const d = deps();
    const r = check(community([file('src/cli/main.ts')]), notes(record()), d);
    expect(r.code).toBe(1);
    expect(fails(r)).toMatch(/community PR changes src\/cli\/main\.ts/);
    expect(fails(r)).toMatch(/pack: not built, the community limits failed/);
    expect(d.calls.build).toBe(0);
  });

  it('a docs-only community PR with the verifier record passes', () => {
    const r = check(community([file('docs/sp4-test.md')]), notes(record()), deps());
    expect(fails(r)).toBe('');
    expect(last(r)).toMatch(/^PASS sp4-check dashlint\/dashlint#1 \(community, /);
  });

  it('needs a verifier record naming the head commit', () => {
    expect(fails(check(community([file('docs/a.md')]), notes(), deps()))).toMatch(
      /no verifier record/,
    );
    expect(
      fails(check(community([file('docs/a.md')]), notes(record('f'.repeat(40))), deps())),
    ).toMatch(/must name head 7bb1e9876e13/);
  });

  it('more than 200 changed lines fails', () => {
    const r = check(community([file('docs/a.md', 150, 51)]), notes(record()), deps());
    expect(fails(r)).toMatch(/changes 201 lines \(limit 200\)/);
  });

  it('descriptor data needs a fixture and an expectation', () => {
    const bare = check(community([file('descriptors/shelf.yml')]), notes(record()), deps());
    expect(fails(bare)).toMatch(/without a matching fixture/);
    expect(fails(bare)).toMatch(/without a matching golden or expectation/);
    const full = check(
      community([
        file('descriptors/builtins/shelf.yml'),
        file('test/fixtures/extract/shelf/calls/src/app.ts'),
        file('test/unit/descriptors/shelf.test.ts'),
      ]),
      notes(record()),
      deps(),
    );
    expect(fails(full)).toBe('');
  });

  it('anything that is neither docs nor descriptor data fails', () => {
    const r = check(
      community([file('descriptors/stubs/shelf.d.ts'), file('test/x.test.ts')]),
      notes(record()),
      deps(),
    );
    expect(fails(r)).toMatch(
      /neither docs-only nor descriptor data: descriptors\/stubs\/shelf\.d\.ts, test\/x\.test\.ts/,
    );
  });
});

describe('the demo repo', () => {
  it('a demo PR checks the diff and has no pack', () => {
    const rec = { ...recorded(), repo: 'demo' };
    rec.pr.headRefName = 'demo/2026-11-14-rename';
    const d = deps();
    const r = check(rec, notes(), d);
    expect(fails(r)).toBe('');
    expect(r.out.join('\n')).toMatch(/the demo publishes no package or bundle/);
    expect(d.calls.build).toBe(0);
  });
});

describe('run and gather', () => {
  it('run records the gathered PR and prints PASS last', () => {
    const o = notes();
    const out = join(scratch('dashlint-sp4-rec-'), 'rec.json');
    const d = deps();
    const r = run(
      ['cli', '1', '--notes', o.notes, '--record', out],
      {},
      {
        ...d,
        gather: () => recorded(),
        headTree: () => d.headDir,
        buildPack: d.buildPack,
      },
    );
    expect(last(r)).toMatch(/^PASS /);
    expect(JSON.parse(readFileSync(out, 'utf8')).pr.number).toBe(1);
  });

  it('usage errors and gather failures exit 2 with a FAIL last line', () => {
    expect(run(['web', '1'], {}).code).toBe(2);
    expect(run(['cli', 'x'], {}).code).toBe(2);
    const r = run(
      ['cli', '1', '--notes', notes().notes],
      {},
      {
        ...deps(),
        gather: () => {
          throw new Error('gh pr view failed: HTTP 404');
        },
        headTree: () => '',
      },
    );
    expect(r.code).toBe(2);
    expect(last(r)).toMatch(/^FAIL sp4-check dashlint\/dashlint#1: could not check/);
  });

  it('gather reads the PR, every page of files, the diff and the base files with GET only', () => {
    const rec = recorded();
    const calls: string[][] = [];
    const page = (n: number, k: number) =>
      Array.from({ length: k }, (_, i) => ({
        filename: `docs/p${n}-${i}.md`,
        status: 'added',
        additions: 1,
        deletions: 0,
      }));
    const gh = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'pr' && args[1] === 'view')
        return { status: 0, stdout: JSON.stringify(rec.pr), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'diff')
        return { status: 1, stdout: '', stderr: 'diff too large' };
      const url = args[3];
      if (url.includes('/files?')) {
        const n = Number(/&page=(\d+)/.exec(url)?.[1]);
        return { status: 0, stdout: JSON.stringify(page(n, n === 1 ? 100 : 3)), stderr: '' };
      }
      if (url.includes('contents/package.json'))
        return {
          status: 0,
          stdout: Buffer.from('{"name":"dashlint"}').toString('base64'),
          stderr: '',
        };
      return { status: 1, stdout: '', stderr: 'HTTP 404' };
    };
    const g = gather('cli', 1, gh);
    expect(g.files).toHaveLength(103);
    expect(g.diff).toBe(null);
    expect(g.diffNote).toBe('diff too large');
    expect(g.base).toEqual({ 'package.json': '{"name":"dashlint"}', '.gitleaks.toml': null });
    for (const a of calls.filter((c) => c[0] === 'api'))
      expect(a.slice(1, 3)).toEqual(['--method', 'GET']);
    expect(calls.every((c) => c.includes('--repo') || c[0] === 'api')).toBe(true);
  });

  it('addedLines keeps only the added lines with their file', () => {
    const lines = addedLines(`${diffFor('a.md', ['one', 'two'])}-gone\n`);
    expect(lines).toEqual([
      { file: 'a.md', text: 'one' },
      { file: 'a.md', text: 'two' },
    ]);
  });
});

// The recorded fixture itself stays clean (G1, G7): it is public test data.
describe('the recorded fixture', () => {
  it('has no dash and names only the public test PR', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    expect(text).not.toContain(EM_DASH);
    expect(text).not.toContain(EN_DASH);
    expect(JSON.parse(text).pr.url).toBe('https://github.com/dashlint/dashlint/pull/1');
  });
});
