// The HTML report (spec 6.9.5): one self-contained file with inline CSS and an inline script, no
// external requests and no tracking. A scorecard, one table per dashboard, alerts, not arriving,
// unknowns and the closing sentence (G11). Every string comes from messages.ts. The only links are
// tile URLs and code locations. Choices the spec leaves open: ADR-050.
import type { Location, ReportTile, Verdict } from '../formats/report.js';
import type { ReportModel } from './build.js';
import { CLOSING_SENTENCE, htmlText, reportText } from './messages.js';

export interface HtmlOptions {
  /**
   * The repository's web URL (https) and the commit or branch to link code locations to. Left out
   * when the remote is not known; code locations are then plain text.
   */
  repository?: { url: string; ref: string };
}

/** Table rows by verdict, worst first; the sort buttons reorder them in the browser. */
const ORDER: readonly Verdict[] = [
  'dead',
  'partly-dead',
  'degraded',
  'one-platform',
  'not-checked',
  'live',
  'ignored',
];

/** Text as HTML text or a double-quoted attribute value. */
export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** A message: escaped, with `name` spans as <code>. */
const rich = (text: string): string => escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');

/** A tile URL from the snapshot, only when it is http(s); anything else is not linked. */
const tileHref = (url: string | undefined): string | undefined =>
  url !== undefined && /^https?:\/\/[^\s"'<>`]+$/.test(url) ? url : undefined;

/** `https://host/owner/repo` from the option, or undefined when it is not a plain https URL. */
function repositoryBase(options: HtmlOptions): { url: string; ref: string } | undefined {
  const r = options.repository;
  if (r === undefined || !/^https:\/\/[^\s"'<>`?#]+$/.test(r.url)) return undefined;
  if (!/^[\w./-]+$/.test(r.ref)) return undefined;
  return { url: r.url.replace(/\/+$/, '').replace(/\.git$/, ''), ref: r.ref };
}

const encodePath = (file: string) => file.split('/').map(encodeURIComponent).join('/');

function siteLinks(sites: readonly Location[], options: HtmlOptions): string {
  const seen = new Map(sites.map((s) => [`${s.file}:${s.line}`, s]));
  const repo = repositoryBase(options);
  const items = [...seen.entries()].map(([label, s]) =>
    repo === undefined
      ? `<li><code>${escapeHtml(label)}</code></li>`
      : `<li><a href="${escapeHtml(`${repo.url}/blob/${repo.ref}/${encodePath(s.file)}#L${s.line}`)}"><code>${escapeHtml(label)}</code></a></li>`,
  );
  return items.length === 0 ? '' : `<ul class="sites">${items.join('')}</ul>`;
}

function counts(tiles: readonly ReportTile[]) {
  const n = (v: Verdict) => tiles.filter((t) => t.verdict === v).length;
  return {
    live: n('live'),
    dead: n('dead'),
    partlyDead: n('partly-dead'),
    degraded: n('degraded'),
    onePlatform: n('one-platform'),
    notChecked: n('not-checked'),
    ignored: n('ignored'),
  };
}

const badge = (v: Verdict) =>
  `<span class="v v-${v}">${escapeHtml(reportText.verdictLabel(v))}</span>`;

function reasons(model: ReportModel, tile: ReportTile): string[] {
  const out = (model.notes[tile.id] ?? []).map((n) => `<li>${rich(n)}</li>`);
  for (const f of tile.findings) if (f.effect !== 'info') out.push(`<li>${rich(f.message)}</li>`);
  if (tile.verdict === 'one-platform') {
    const missing = model.platforms.filter((p) => !tile.platforms.includes(p));
    out.push(`<li>${rich(reportText.onePlatform(tile.platforms, missing))}</li>`);
  }
  if (tile.verdict === 'not-checked')
    for (const p of tile.unknownParts)
      out.push(`<li>${rich(reportText.unknownPart(p.path, p.reason))}</li>`);
  return out;
}

function tileRow(model: ReportModel, tile: ReportTile, options: HtmlOptions): string {
  const href = tileHref(tile.url);
  const title = escapeHtml(tile.title);
  const why = reasons(model, tile);
  const sites = tile.findings.filter((f) => f.effect !== 'info').flatMap((f) => f.sites);
  return [
    `<tr data-verdict="${tile.verdict}">`,
    `<td data-rank="${ORDER.indexOf(tile.verdict)}">${badge(tile.verdict)}</td>`,
    `<th scope="row">${href === undefined ? title : `<a href="${escapeHtml(href)}">${title}</a>`}</th>`,
    `<td>${tile.platforms.length === 0 ? escapeHtml(htmlText.noPlatforms) : escapeHtml(tile.platforms.join(', '))}</td>`,
    `<td>${why.length === 0 ? '' : `<ul>${why.join('')}</ul>`}</td>`,
    `<td>${siteLinks(sites, options)}</td>`,
    '</tr>',
  ].join('');
}

function dashboardSection(
  model: ReportModel,
  name: string,
  tiles: readonly ReportTile[],
  index: number,
  options: HtmlOptions,
): string[] {
  const c = htmlText.columns;
  const head = [c.verdict, c.tile, c.platforms, c.reasons, c.code].map(
    (label, i) =>
      `<th scope="col" aria-sort="none"><button type="button" data-col="${i}">${escapeHtml(label)}</button></th>`,
  );
  const id = `d${index}`;
  const rows: string[] = [];
  for (const verdict of ORDER)
    for (const tile of tiles.filter((t) => t.verdict === verdict))
      rows.push(tileRow(model, tile, options));
  return [
    `<section aria-labelledby="${id}">`,
    `<h2 id="${id}">${escapeHtml(name)}</h2>`,
    `<p>${escapeHtml(reportText.dashboard(name, tiles.length, reportText.counts(counts(tiles))))}</p>`,
    '<div class="scroll"><table>',
    `<thead><tr>${head.join('')}</tr></thead>`,
    '<tbody>',
    ...rows,
    '</tbody></table></div>',
    '</section>',
  ];
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#555;--line:#d0d0d0;--head:#f3f3f3;--link:#0645ad;
--dead-bg:#fde2e2;--dead-fg:#8a1010;--part-bg:#fdebd8;--part-fg:#7a3a00;--deg-bg:#fff4c2;--deg-fg:#5c4400;
--one-bg:#e3ecfd;--one-fg:#1d3f8a;--nc-bg:#ececec;--nc-fg:#333;--live-bg:#dff3e2;--live-fg:#14562a}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#b0b0b0;--line:#3a3a3a;
--head:#1f1f1f;--link:#8ab4f8;--dead-bg:#4a1212;--dead-fg:#ffd2d2;--part-bg:#4a2a0a;--part-fg:#ffdcb8;
--deg-bg:#3d3300;--deg-fg:#fff0a8;--one-bg:#16264a;--one-fg:#cfe0ff;--nc-bg:#2c2c2c;--nc-fg:#e0e0e0;
--live-bg:#123a1c;--live-fg:#c8f0d0}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:.5rem 0}h2{font-size:1.2rem;margin:1.5rem 0 .5rem}
.meta,.small{color:var(--muted)}
.score{font-size:1.3rem;font-weight:600}
a{color:var(--link)}
code{font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
thead th{background:var(--head)}
thead button{all:inherit;cursor:pointer;padding:0}
thead button:focus-visible{outline:2px solid var(--link)}
td ul,section ul{margin:0;padding-left:1.2rem}
ul.sites{list-style:none;padding:0}
.v{display:inline-block;padding:1px 6px;border-radius:4px;font-size:12px;font-weight:700;white-space:nowrap}
.v-dead{background:var(--dead-bg);color:var(--dead-fg)}
.v-partly-dead{background:var(--part-bg);color:var(--part-fg)}
.v-degraded{background:var(--deg-bg);color:var(--deg-fg)}
.v-one-platform{background:var(--one-bg);color:var(--one-fg)}
.v-not-checked,.v-ignored{background:var(--nc-bg);color:var(--nc-fg)}
.v-live{background:var(--live-bg);color:var(--live-fg)}
footer{margin:2rem 0 1rem;font-weight:600}
`.trim();

// Sorting and filtering (cut-order item 4). Without the script the static tables read the same.
const SCRIPT = `
(function(){
var f=document.getElementById('filter');
if(f){f.hidden=false;f.querySelector('select').addEventListener('change',function(e){
var v=e.target.value;document.querySelectorAll('tbody tr').forEach(function(r){
r.hidden=v!==''&&r.getAttribute('data-verdict')!==v;});});}
document.querySelectorAll('thead button').forEach(function(b){b.addEventListener('click',function(){
var th=b.parentNode,table=th.closest('table'),body=table.tBodies[0],col=Number(b.getAttribute('data-col'));
var asc=th.getAttribute('aria-sort')!=='ascending';
table.querySelectorAll('thead th').forEach(function(h){h.setAttribute('aria-sort','none');});
th.setAttribute('aria-sort',asc?'ascending':'descending');
var key=function(r){var c=r.cells[col];var k=c.getAttribute('data-rank');return k===null?c.textContent.trim().toLowerCase():Number(k);};
Array.prototype.slice.call(body.rows).sort(function(a,c){var x=key(a),y=key(c);var d=x<y?-1:x>y?1:0;return asc?d:-d;})
.forEach(function(r){body.appendChild(r);});});});
})();
`.trim();

/** The HTML report, newline-terminated. Deterministic: the same model gives the same bytes. */
export function renderHtml(model: ReportModel, options: HtmlOptions = {}): string {
  const { report } = model;
  const r = report.requirements;
  const s = report.summary;
  const out: string[] = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`,
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(htmlText.title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(htmlText.title)}</h1>`,
    `<p class="meta">${escapeHtml(reportText.header(report.tool, r.platform, r.project, r.pulledAt))}</p>`,
  ];
  if (!r.observed) out.push(`<p>${escapeHtml(reportText.noObserved(r.platform))}</p>`);
  out.push(
    `<p class="small">${escapeHtml(model.sources.length === 0 ? reportText.noSources : reportText.sources(model.sources))}</p>`,
  );
  const sum = (k: 'callSites' | 'literalNameSites' | 'openSites') =>
    model.sources.reduce((n, src) => n + src[k], 0);
  out.push(
    `<p class="small">${escapeHtml(reportText.catalog(sum('callSites'), sum('literalNameSites'), sum('openSites')))}</p>`,
    '<section aria-labelledby="summary">',
    `<h2 id="summary">${escapeHtml(htmlText.summary)}</h2>`,
    `<p class="score">${escapeHtml(htmlText.score(s.live, s.tiles))}</p>`,
    `<p>${escapeHtml(reportText.counts(counts(report.tiles)))}</p>`,
    `<p>${escapeHtml(reportText.alerts(s.alerts.checked, s.alerts.canNeverFire, s.alerts.firesEveryCheck, s.alerts.invalidTarget))}</p>`,
    `<p>${escapeHtml(reportText.unknownTotal(s.unknownParts))}</p>`,
    '</section>',
  );

  const verdictOptions = ORDER.filter((v) => report.tiles.some((t) => t.verdict === v)).map(
    (v) => `<option value="${v}">${escapeHtml(reportText.verdictLabel(v))}</option>`,
  );
  if (report.tiles.length > 0)
    out.push(
      '<p id="filter" hidden><label>',
      `${escapeHtml(htmlText.filterLabel)} <select><option value="">${escapeHtml(htmlText.filterAll)}</option>${verdictOptions.join('')}</select>`,
      '</label></p>',
    );

  let index = 0;
  for (const d of model.dashboards) {
    const tiles = report.tiles.filter((t) => t.dashboards.includes(d.id));
    if (tiles.length > 0) out.push(...dashboardSection(model, d.name, tiles, index++, options));
  }
  const known = new Set(model.dashboards.map((d) => d.id));
  const loose = report.tiles.filter((t) => !t.dashboards.some((id) => known.has(id)));
  if (loose.length > 0)
    out.push(...dashboardSection(model, reportText.noDashboard, loose, index++, options));

  out.push(
    '<section aria-labelledby="alerts">',
    `<h2 id="alerts">${escapeHtml(htmlText.alerts)}</h2>`,
    `<p>${escapeHtml(reportText.alerts(s.alerts.checked, s.alerts.canNeverFire, s.alerts.firesEveryCheck, s.alerts.invalidTarget))}</p>`,
  );
  const alertItems = report.alerts.flatMap((a) =>
    (a.findings ?? []).map(
      (f) =>
        `<li>${rich(reportText.alertLine(a.name ?? a.id, f.message, a.state, a.enabled))}${siteLinks(f.sites, options)}</li>`,
    ),
  );
  if (alertItems.length > 0) out.push(`<ul>${alertItems.join('')}</ul>`);
  out.push('</section>');

  out.push(
    '<section aria-labelledby="not-arriving">',
    `<h2 id="not-arriving">${escapeHtml(htmlText.notArriving)}</h2>`,
  );
  if (!r.observed) out.push(`<p>${escapeHtml(htmlText.notArrivingNotRead)}</p>`);
  else if (report.notArriving.length === 0)
    out.push(`<p>${escapeHtml(htmlText.notArrivingNone)}</p>`);
  else
    out.push(
      `<ul>${report.notArriving
        .map(
          (n) =>
            `<li>${rich(htmlText.notArrivingLine(n.event, model.windowDays ?? 0, n.enforcement))}${siteLinks(n.sites, options)}</li>`,
        )
        .join('')}</ul>`,
    );
  out.push('</section>');

  out.push(
    '<section aria-labelledby="unknowns">',
    `<h2 id="unknowns">${escapeHtml(htmlText.unknowns)}</h2>`,
    `<p>${escapeHtml(reportText.unknownTotal(s.unknownParts))}</p>`,
  );
  const unknown = report.tiles.filter((t) => t.unknownParts.length > 0);
  if (unknown.length > 0)
    out.push(
      `<ul>${unknown
        .map(
          (t) =>
            `<li>${escapeHtml(t.title)}<ul>${t.unknownParts
              .map((p) => `<li>${rich(reportText.unknownPart(p.path, p.reason))}</li>`)
              .join('')}</ul></li>`,
        )
        .join('')}</ul>`,
    );
  out.push('</section>');

  if (model.warnings.length > 0)
    out.push(
      '<section aria-labelledby="warnings">',
      `<h2 id="warnings">${escapeHtml(htmlText.warnings)}</h2>`,
      `<ul>${model.warnings
        .map(
          (w) =>
            `<li>${escapeHtml(
              w.code === 'ignore-expired'
                ? reportText.ignoreExpired(w.entry.id, w.entry.until ?? '')
                : reportText.ignoreUnmatched(w.entry.id),
            )}</li>`,
        )
        .join('')}</ul>`,
      '</section>',
    );

  out.push(
    `<footer><p>${escapeHtml(CLOSING_SENTENCE)}</p></footer>`,
    '</main>',
    `<script>${SCRIPT}</script>`,
    '</body>',
    '</html>',
  );
  return `${out.join('\n')}\n`;
}
