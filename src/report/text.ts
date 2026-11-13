// The text report (spec 6.9.3): header, one block per dashboard with its tiles that are not live,
// then not arriving, alerts, unknowns, warnings and the closing sentence (G11). Every string comes
// from messages.ts.
import type { ReportTile, Verdict } from '../formats/report.js';
import type { ReportModel } from './build.js';
import { CLOSING_SENTENCE, formatSites, reportText } from './messages.js';

/** Columns the verdict label takes; the lines under a tile start here. */
const LABEL = 14;
/** Lines are wrapped at this width. */
const WIDTH = 100;

const ORDER: readonly Verdict[] = [
  'dead',
  'partly-dead',
  'degraded',
  'one-platform',
  'not-checked',
];

export interface TextOptions {
  /** The HTML report written next to this output, if any. */
  htmlFile?: string;
}

/** Words of `text` on lines of at most WIDTH columns, each after `indent` spaces. */
export function wrap(text: string, indent: number, width = WIDTH): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (indent + line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(pad + line);
      line = word;
    }
  }
  if (line !== '') lines.push(pad + line);
  return lines;
}

/** A ` · ` separated line, broken between its items when it is longer than WIDTH. */
export function wrapItems(text: string, width = WIDTH): string[] {
  const lines: string[] = [];
  let line = '';
  for (const item of text.split(' · ')) {
    if (line === '') line = item;
    else if (line.length + 3 + item.length <= width) line = `${line} · ${item}`;
    else {
      lines.push(`${line} ·`);
      line = item;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
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

function tileBlock(model: ReportModel, tile: ReportTile): string[] {
  const notes = model.notes[tile.id] ?? [];
  const title = `${reportText.verdictLabel(tile.verdict).padEnd(LABEL)}${tile.title}`;
  const note = `(${notes.join('; ')})`;
  // Notes follow the title, or go under it when the line would be too long.
  const out =
    notes.length === 0
      ? [title]
      : title.length + 3 + note.length <= WIDTH
        ? [`${title}   ${note}`]
        : [title, ...wrap(note, LABEL)];
  for (const f of tile.findings) {
    if (f.effect === 'info') continue;
    out.push(...wrap(f.message, LABEL));
    if (f.sites.length > 0) out.push(...wrap(formatSites(f.sites), LABEL));
  }
  if (tile.verdict === 'one-platform') {
    const missing = model.platforms.filter((p) => !tile.platforms.includes(p));
    out.push(...wrap(reportText.onePlatform(tile.platforms, missing), LABEL));
  }
  if (tile.verdict === 'not-checked') {
    for (const p of tile.unknownParts)
      out.push(...wrap(reportText.unknownPart(p.path, p.reason), LABEL));
  }
  return out;
}

function dashboardBlock(model: ReportModel, name: string, tiles: readonly ReportTile[]): string[] {
  const out = wrapItems(reportText.dashboard(name, tiles.length, reportText.counts(counts(tiles))));
  for (const verdict of ORDER)
    for (const tile of tiles.filter((t) => t.verdict === verdict))
      out.push('', ...tileBlock(model, tile));
  return out;
}

/** The text report, newline-terminated. */
export function renderText(model: ReportModel, options: TextOptions = {}): string {
  const { report } = model;
  const r = report.requirements;
  const lines: string[] = [reportText.header(report.tool, r.platform, r.project, r.pulledAt)];
  if (!r.observed) lines.push(reportText.noObserved(r.platform));
  if (model.sources.length === 0) lines.push(reportText.noSources);
  else lines.push(...wrapItems(reportText.sources(model.sources)));
  const sum = (k: 'callSites' | 'literalNameSites' | 'openSites') =>
    model.sources.reduce((n, s) => n + s[k], 0);
  lines.push(reportText.catalog(sum('callSites'), sum('literalNameSites'), sum('openSites')));

  for (const d of model.dashboards) {
    const tiles = report.tiles.filter((t) => t.dashboards.includes(d.id));
    if (tiles.length > 0) lines.push('', ...dashboardBlock(model, d.name, tiles));
  }
  const known = new Set(model.dashboards.map((d) => d.id));
  const loose = report.tiles.filter((t) => !t.dashboards.some((id) => known.has(id)));
  if (loose.length > 0) lines.push('', ...dashboardBlock(model, reportText.noDashboard, loose));

  lines.push('');
  for (const n of report.notArriving)
    lines.push(
      ...wrap(reportText.notArriving(n.event, n.sites, model.windowDays ?? 0, n.enforcement), 0),
    );
  const a = report.summary.alerts;
  lines.push(
    ...wrapItems(reportText.alerts(a.checked, a.canNeverFire, a.firesEveryCheck, a.invalidTarget)),
  );
  for (const alert of report.alerts)
    for (const f of alert.findings ?? [])
      lines.push(
        ...wrap(
          reportText.alertLine(alert.name ?? alert.id, f.message, alert.state, alert.enabled),
          2,
        ),
      );
  lines.push(reportText.unknownTotal(report.summary.unknownParts));
  for (const w of model.warnings)
    lines.push(
      w.code === 'ignore-expired'
        ? reportText.ignoreExpired(w.entry.id, w.entry.until ?? '')
        : reportText.ignoreUnmatched(w.entry.id),
    );
  if (options.htmlFile !== undefined) lines.push(reportText.written(options.htmlFile));
  lines.push(CLOSING_SENTENCE);
  return `${lines.join('\n')}\n`;
}
