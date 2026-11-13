import { describe, expect, it } from 'vitest';
import type { CatalogChange, DiffResult } from '../../../src/check/index.js';
import type { Finding } from '../../../src/formats/report.js';
import {
  CLOSING_SENTENCE,
  commentText,
  explains,
  renderComment,
  type CommentInput,
} from '../../../src/report/index.js';
import { bookshop } from '../../fixtures/report/bookshop.js';
import { noopPr, renamePr } from '../../fixtures/report/bookshop-diff.js';
import { expectGolden } from './golden.js';

describe('PR comment goldens (spec 6.9.6)', () => {
  it('a rename and a dropped property', () => {
    expectGolden('markdown/bookshop-rename.md', renderComment(renamePr()));
  });

  it('a pull request that changes no analytics call', () => {
    expectGolden('markdown/bookshop-noop.md', renderComment(noopPr()));
  });
});

const emptyDiff = (): DiffResult => ({
  failOn: 'dead',
  base: { commit: 'a' },
  head: { commit: 'b' },
  worse: [],
  fixed: [],
  changed: [],
  alreadyBroken: 0,
  ignored: 0,
  alerts: { worse: [], fixed: [] },
  requirements: { status: 'unchanged', tiles: [] },
  catalog: [],
  warnings: [],
  fails: false,
});

const input = (diff: Partial<DiffResult>): CommentInput => ({
  diff: { ...emptyDiff(), ...diff },
  head: bookshop({ mode: 'diff' }),
  requirementsFile: 'dashlint.requirements.json',
});

describe('renderComment', () => {
  it('starts with the hidden marker and ends with the closing sentence (G11)', () => {
    for (const c of [renamePr(), noopPr(), input({})]) {
      const md = renderComment(c);
      expect(md.startsWith('<!-- dashlint:v1 -->\n')).toBe(true);
      expect(md).toContain(CLOSING_SENTENCE.slice(1, -1));
      expect(md.trimEnd().endsWith('</sub>')).toBe(true);
    }
  });

  it('has no em or en dash', () => {
    for (const c of [renamePr(), noopPr()]) {
      const md = renderComment(c);
      expect(md).not.toContain(String.fromCodePoint(0x2013));
      expect(md).not.toContain(String.fromCodePoint(0x2014));
    }
  });

  it('counts the broken tiles and alerts in the title', () => {
    const md = renderComment(renamePr());
    const c = renamePr();
    expect(md.split('\n')[1]).toBe(
      commentText.title(c.diff.worse.length, c.diff.alerts.worse.length),
    );
    expect(c.diff.worse.length).toBeGreaterThan(0);
    expect(c.diff.alerts.worse.length).toBeGreaterThan(0);
  });

  it('has no table when nothing broke', () => {
    const md = renderComment(noopPr());
    expect(md).toContain('this PR breaks no tiles or alerts');
    expect(md).not.toContain('| Change | Breaks |');
  });

  it('always prints the open call sites and the unknown parts, also at zero', () => {
    const c = input({});
    c.head = {
      ...c.head,
      sources: [],
      report: { ...c.head.report, summary: { ...c.head.report.summary, unknownParts: 0 } },
    };
    const md = renderComment(c);
    expect(md).toContain('0 call sites have non-literal event names.');
    expect(md).toContain('0 parts could not be decided.');
  });

  it('lists a tile no catalog change explains under other changes', () => {
    const md = renderComment(
      input({
        worse: [
          {
            id: 'insight:Rs06',
            title: 'Reviews submitted',
            base: 'live',
            head: 'one-platform',
            fails: false,
          },
        ],
      }),
    );
    expect(md).toContain('| Other changes in this PR | Trend "Reviews submitted" (one platform) |');
  });

  it('names the base verdict when the tile was not live before', () => {
    const md = renderComment(
      input({
        worse: [
          {
            id: 'insight:Of05',
            title: 'Orders by format',
            base: 'degraded',
            head: 'dead',
            fails: true,
          },
        ],
      }),
    );
    expect(md).toContain('(dead, was degraded)');
  });

  it('lists fixed tiles and alerts', () => {
    const md = renderComment(
      input({
        fixed: [
          {
            id: 'insight:Ws02',
            title: 'Wishlist shares, fiction',
            base: 'dead',
            head: 'live',
            fails: false,
          },
        ],
        alerts: {
          worse: [],
          fixed: [
            {
              id: 'alert:0b7e',
              name: 'Gift cards dropped',
              tile: 'insight:Gc03',
              base: 'can-never-fire',
              head: 'ok',
            },
          ],
        },
      }),
    );
    expect(md).toContain(
      'Fixed by this PR: Trend "Wishlist shares, fiction" (live, was dead), Alert "Gift cards dropped" (was can never fire).',
    );
  });

  it('prints the already broken count only when there is one, worded by failOn', () => {
    expect(renderComment(input({}))).not.toContain('already');
    expect(renderComment(input({ alreadyBroken: 2 }))).toContain(
      '2 tiles were already dead before this PR.',
    );
    expect(renderComment(input({ alreadyBroken: 1, failOn: 'degraded' }))).toContain(
      '1 tile was already broken before this PR.',
    );
  });

  it('says when the requirements file changed or is new, as information', () => {
    expect(
      renderComment(
        input({
          requirements: {
            status: 'changed',
            tiles: [{ id: 'x', title: 'X', change: 'added', after: 'live' }],
          },
        }),
      ),
    ).toContain('1 tile changed because of that (information, never a failure)');
    expect(renderComment(input({ requirements: { status: 'new', tiles: [] } }))).toContain(
      commentText.requirementsNew,
    );
    expect(renderComment(input({ requirements: { status: 'changed', tiles: [] } }))).not.toContain(
      'changes the requirements file',
    );
  });

  it('prints catalog sites as the catalog gives them: repository-relative, never prefixed again', () => {
    const change: CatalogChange = {
      kind: 'event-removed',
      event: 'book_viewed',
      sites: [{ source: 'web', file: 'web/src/catalog/book.ts', line: 20 }],
    };
    const worse = [
      {
        id: 'insight:Bv01',
        title: 'Books viewed',
        base: 'live' as const,
        head: 'dead' as const,
        fails: true,
      },
    ];
    const c = input({ worse, catalog: [change] });
    // The head model is the bookshop as is; give its tile the finding the removal would cause.
    c.head.report.tiles = c.head.report.tiles.map((t) =>
      t.id === 'insight:Bv01'
        ? {
            ...t,
            findings: [
              {
                check: 'event-has-call-site',
                path: 'series[0]',
                effect: 'dead',
                event: 'book_viewed',
                code: 'no',
                sites: [],
                message: 'm',
              },
            ],
          }
        : t,
    );
    expect(renderComment(c)).toContain(
      '| `book_viewed` removed (web/src/catalog/book.ts:20) | Trend "Books viewed" (dead) |',
    );
    expect(renderComment(c)).not.toContain('web/web/');
  });

  it('shows three sites and counts the rest', () => {
    const sites = [1, 2, 3, 4, 5].map((line) => ({ source: 'web', file: 'web/a.ts', line }));
    const change: CatalogChange = { kind: 'event-removed', event: 'book_viewed', sites };
    const c = input({
      worse: [
        { id: 'insight:Bv01', title: 'Books viewed', base: 'live', head: 'dead', fails: true },
      ],
      catalog: [change],
    });
    c.head.report.tiles = c.head.report.tiles.map((t) =>
      t.id === 'insight:Bv01'
        ? {
            ...t,
            findings: [
              {
                check: 'event-has-call-site',
                path: 'series[0]',
                effect: 'dead',
                event: 'book_viewed',
                code: 'no',
                sites: [],
                message: 'm',
              },
            ],
          }
        : t,
    );
    expect(renderComment(c)).toContain('(web/a.ts:1 · web/a.ts:2 · web/a.ts:3 and 2 more)');
  });

  it('escapes pipes and HTML in table cells', () => {
    const c = input({
      worse: [
        {
          id: 'insight:Bv01',
          title: 'Views | <b>all</b>',
          base: 'live',
          head: 'dead',
          fails: true,
        },
      ],
    });
    c.head.report.tiles = c.head.report.tiles.map((t) =>
      t.id === 'insight:Bv01' ? { ...t, title: 'Views | <b>all</b>' } : t,
    );
    const md = renderComment(c);
    expect(md).toContain('Trend "Views \\| &lt;b>all&lt;/b>" (dead)');
    expect(md).not.toContain('<b>');
  });
});

const finding = (f: Partial<Finding>): Finding => ({
  check: 'property-is-sent',
  path: 'series[0].filters[0]',
  code: 'no',
  sites: [],
  message: 'm',
  ...f,
});

describe('explains', () => {
  const renamed: CatalogChange = {
    kind: 'event-renamed',
    from: 'a',
    to: 'b',
    function: 'f',
    sites: [],
  };
  const removed: CatalogChange = { kind: 'event-removed', event: 'a', sites: [] };
  const added: CatalogChange = { kind: 'event-added', event: 'a', sites: [] };
  const prop: CatalogChange = { kind: 'property-removed', event: 'a', property: 'p' };
  const superProp: CatalogChange = { kind: 'property-removed', event: null, property: 'p' };
  const narrowed: CatalogChange = {
    kind: 'values-narrowed',
    event: 'a',
    property: 'p',
    removed: ['x'],
  };

  it('an event rename or removal explains findings on the old name only', () => {
    expect(explains(renamed, finding({ check: 'event-has-call-site', event: 'a' }))).toBe(true);
    expect(explains(renamed, finding({ check: 'event-has-call-site', event: 'b' }))).toBe(false);
    expect(explains(removed, finding({ event: 'a', property: 'p' }))).toBe(true);
    expect(explains(removed, finding({ event: 'c' }))).toBe(false);
  });

  it('an added event explains nothing', () => {
    expect(explains(added, finding({ event: 'a' }))).toBe(false);
  });

  it('a removed property explains property findings on that event, any event for a super', () => {
    expect(explains(prop, finding({ event: 'a', property: 'p' }))).toBe(true);
    expect(explains(prop, finding({ event: 'c', property: 'p' }))).toBe(false);
    expect(explains(prop, finding({ event: 'a', property: 'q' }))).toBe(false);
    expect(
      explains(prop, finding({ check: 'event-has-call-site', event: 'a', property: 'p' })),
    ).toBe(false);
    expect(explains(prop, finding({ property: 'p' }))).toBe(true);
    expect(explains(superProp, finding({ event: 'c', property: 'p' }))).toBe(true);
  });

  it('narrowed values explain value findings only', () => {
    expect(
      explains(narrowed, finding({ check: 'value-is-reachable', event: 'a', property: 'p' })),
    ).toBe(true);
    expect(explains(narrowed, finding({ event: 'a', property: 'p' }))).toBe(false);
    expect(
      explains(narrowed, finding({ check: 'value-is-reachable', event: 'c', property: 'p' })),
    ).toBe(false);
  });
});
