import { describe, expect, it } from 'vitest';
import type { ReportTile } from '../../../src/formats/report.js';
import type { HtmlOptions, ReportModel } from '../../../src/report/index.js';
import { CLOSING_SENTENCE, escapeHtml, renderHtml } from '../../../src/report/index.js';
import { bookshop } from '../../fixtures/report/bookshop.js';
import { expectGolden } from './golden.js';

const REPO: HtmlOptions = {
  repository: { url: 'https://git.example.com/bookshop/bookshop', ref: '4f2c9a1' },
};

describe('HTML report goldens (spec 6.9.5)', () => {
  it('the bookshop with PostHog data and a known repository', () => {
    expectGolden('html/bookshop.html', renderHtml(bookshop(), REPO));
  });

  it('the bookshop from code alone, no repository', () => {
    expectGolden('html/bookshop-code-only.html', renderHtml(bookshop({ observed: false })));
  });

  it('the bookshop with no ignore list', () => {
    expectGolden('html/bookshop-no-ignore.html', renderHtml(bookshop({ ignore: [] }), REPO));
  });
});

/**
 * Every URL the page could load or link: src, href, srcset, action, url( and @import. A page that
 * works offline and tracks nothing has none but the tile and code links.
 */
function externalRefs(html: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:src|href|action|srcset|poster|data|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi,
    /@import\s+(?:"([^"]*)"|'([^']*)'|(\S+))/gi,
  ];
  for (const re of patterns)
    for (const m of html.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  return out;
}

const remote = (url: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url.replace(/&amp;/g, '&'));

function unexpectedRefs(model: ReportModel, html: string, options: HtmlOptions): string[] {
  const tiles = new Set(model.report.tiles.flatMap((t) => (t.url === undefined ? [] : [t.url])));
  const code =
    options.repository === undefined
      ? undefined
      : `${options.repository.url}/blob/${options.repository.ref}/`;
  return externalRefs(html).filter((raw) => {
    const url = raw.replace(/&amp;/g, '&');
    if (!remote(url)) return false;
    if (tiles.has(url)) return false;
    return code === undefined || !url.startsWith(code);
  });
}

describe('HTML report: no external requests, no tracking', () => {
  const cases: [string, ReportModel, HtmlOptions][] = [
    ['with repository', bookshop(), REPO],
    ['code only', bookshop({ observed: false }), {}],
    ['no ignore', bookshop({ ignore: [] }), REPO],
  ];

  it('has no http URL in src, href or url( other than tile and code links', () => {
    for (const [, model, options] of cases)
      expect(unexpectedRefs(model, renderHtml(model, options), options)).toEqual([]);
  });

  it('links tiles and code locations', () => {
    const html = renderHtml(bookshop(), REPO);
    expect(html).toContain('href="https://us.posthog.com/project/12345/insights/');
    expect(html).toContain(
      'href="https://git.example.com/bookshop/bookshop/blob/4f2c9a1/web/src/checkout/gift.ts#L88"',
    );
  });

  it('prints code locations as text when the repository is not known', () => {
    const html = renderHtml(bookshop());
    expect(html).toContain('<code>web/src/checkout/gift.ts:88</code>');
    expect(html).not.toContain('/blob/');
  });

  it('the check catches a stylesheet, script, image, font or import from elsewhere', () => {
    const model = bookshop();
    const html = renderHtml(model);
    for (const extra of [
      '<link rel="stylesheet" href="https://cdn.example.com/a.css">',
      '<script src="//cdn.example.com/a.js"></script>',
      '<img src="http://pixel.example.com/t.gif">',
      '<style>@font-face{src:url(https://fonts.example.com/f.woff2)}</style>',
      "<style>@import 'https://cdn.example.com/b.css';</style>",
    ]) {
      const bad = html.replace('</head>', `${extra}\n</head>`);
      expect(unexpectedRefs(model, bad, {}).length, extra).toBeGreaterThan(0);
    }
  });

  it('declares a policy that blocks every load but inline style and script', () => {
    expect(renderHtml(bookshop())).toContain(
      `content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"`,
    );
  });

  it('does not link a tile URL that is not http(s), and escapes every snapshot string', () => {
    const model = bookshop();
    const tile = model.report.tiles[0] as ReportTile;
    const hostile: ReportModel = {
      ...model,
      report: {
        ...model.report,
        tiles: [
          { ...tile, title: '<script>x()</script> "q" & \'s\'', url: 'javascript:x()' },
          ...model.report.tiles.slice(1),
        ],
      },
    };
    const html = renderHtml(hostile, REPO);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script>x()');
    expect(html).toContain('&lt;script&gt;x()&lt;/script&gt; &quot;q&quot; &amp; &#39;s&#39;');
  });

  it('links no code when the repository URL is not plain https', () => {
    for (const url of [
      'javascript:x()',
      'http://git.example.com/a/b',
      'https://a.example.com/"x',
    ]) {
      const html = renderHtml(bookshop(), { repository: { url, ref: 'main' } });
      expect(html, url).not.toContain('/blob/');
    }
    const badRef = renderHtml(bookshop(), {
      repository: { url: 'https://git.example.com/a/b', ref: 'main"><x' },
    });
    expect(badRef).not.toContain('/blob/');
  });

  it('drops a trailing .git and slash from the repository URL', () => {
    const html = renderHtml(bookshop(), {
      repository: { url: 'https://git.example.com/bookshop/bookshop.git/', ref: 'main' },
    });
    expect(html).toContain('href="https://git.example.com/bookshop/bookshop/blob/main/web/');
  });
});

describe('HTML report invariants', () => {
  const variants = [bookshop(), bookshop({ observed: false }), bookshop({ ignore: [] })];

  it('ends with the closing sentence before the script (G11)', () => {
    for (const m of variants)
      expect(renderHtml(m)).toContain(`<footer><p>${CLOSING_SENTENCE}</p></footer>`);
  });

  it('always prints the scorecard, the unknown count and the alert counts', () => {
    for (const m of variants) {
      const html = renderHtml(m);
      const s = m.report.summary;
      expect(html).toContain(`<p class="score">${s.live} of ${s.tiles} tiles are live</p>`);
      expect(html).toMatch(/Unknown: \d+ parts? could not be decided/);
      expect(html).toMatch(/Alerts: \d+ checked/);
      expect(html).toContain('<h2 id="not-arriving">Not arriving</h2>');
      expect(html).toContain('<h2 id="unknowns">Unknowns</h2>');
    }
  });

  it('has one table row per tile and dashboard, live and ignored tiles included', () => {
    const m = bookshop();
    const html = renderHtml(m);
    const rows = [...html.matchAll(/<tr data-verdict="([a-z-]+)">/g)].map((r) => r[1]);
    const expected = m.report.tiles.reduce(
      (n, t) =>
        n + Math.max(1, t.dashboards.filter((d) => m.dashboards.some((x) => x.id === d)).length),
      0,
    );
    expect(rows.length).toBe(expected);
    for (const v of ['live', 'dead', 'ignored']) expect(rows).toContain(v);
  });

  it('marks code names from messages as <code>', () => {
    expect(renderHtml(bookshop())).toContain('<code>gift_card_redeemed</code>');
  });

  it('is accessible markup: language, headings, column and row headers', () => {
    const html = renderHtml(bookshop());
    expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(html).toContain('<h1>');
    const tables = html.match(/<table>/g)?.length ?? 0;
    expect(tables).toBeGreaterThan(0);
    expect(html.match(/<thead>/g)?.length).toBe(tables);
    expect(html.match(/<th scope="col"/g)?.length).toBe(tables * 5);
    expect(html.match(/<th scope="row">/g)?.length).toBe(html.match(/<tr data-verdict/g)?.length);
  });

  it('has no em or en dash and is deterministic', () => {
    for (const m of variants) {
      const html = renderHtml(m);
      expect(html).not.toContain(String.fromCodePoint(0x2013));
      expect(html).not.toContain(String.fromCodePoint(0x2014));
      expect(renderHtml(m)).toBe(html);
    }
  });

  it('a report with no tiles or alerts still has the scorecard, counts and closing', () => {
    const m = bookshop();
    const empty: ReportModel = {
      ...m,
      report: {
        ...m.report,
        tiles: [],
        alerts: [],
        notArriving: [],
        summary: {
          ...m.report.summary,
          tiles: 0,
          live: 0,
          unknownParts: 0,
          alerts: { checked: 0, canNeverFire: 0, firesEveryCheck: 0, invalidTarget: 0 },
        },
      },
      sources: [],
      warnings: [],
    };
    const html = renderHtml(empty);
    expect(html).toContain('<p class="score">0 of 0 tiles are live</p>');
    expect(html).not.toContain('<table>');
    expect(html).not.toContain('id="filter"');
    expect(html).toContain('Unknown: 0 parts could not be decided');
    expect(html).toContain(CLOSING_SENTENCE);
  });
});

describe('HTML report size (spec 6.12)', () => {
  it('stays at or under 2 MB at 200 tiles with long messages and many sites', () => {
    const m = bookshop({ ignore: [] });
    const base = m.report.tiles;
    const tiles: ReportTile[] = [];
    const notes: Record<string, string[]> = {};
    for (let i = 0; i < 200; i++) {
      const t = base[i % base.length] as ReportTile;
      const id = `${t.id}-${i}`;
      tiles.push({
        ...t,
        id,
        title: `${t.title} ${i}`,
        dashboards: m.dashboards.map((d) => d.id),
        findings: [0, 1, 2].map((k) => ({
          check: 'property-is-sent' as const,
          path: `series[${k}].filters[0]`,
          effect: 'dead' as const,
          code: 'no' as const,
          sites: Array.from({ length: 12 }, (_, j) => ({
            file: `web/src/feature${i}/module${k}/component${j}.tsx`,
            line: 100 + j,
          })),
          message: `filters on \`property_${k}\` = "a value", but no call site sends \`property_${k}\` with \`event_${i}\` (they send \`property_${k}_id\`), and PostHog has never seen it on that event`,
        })),
      });
      notes[id] = m.notes[t.id] ?? [];
    }
    const big: ReportModel = {
      ...m,
      report: { ...m.report, tiles, summary: { ...m.report.summary, tiles: 200 } },
      notes,
    };
    const html = renderHtml(big, REPO);
    const bytes = Buffer.byteLength(html, 'utf8');
    expect(html.match(/<tr data-verdict/g)?.length).toBe(200 * m.dashboards.length);
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(unexpectedRefs(big, html, REPO)).toEqual([]);
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter in text and attributes', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
