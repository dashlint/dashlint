// The PR comment (spec 6.9.6): one row per catalog change with the tiles and alerts it breaks, from
// the diff (T6.6) and the head's report model. The hidden marker lets the Action find and update its
// one comment. Choices the spec leaves open: ADR-049.
import type {
  AlertChange,
  CatalogChange,
  DiffResult,
  SourceSite,
  TileChange,
} from '../check/diff.js';
import type { Finding, Location, ReportTile } from '../formats/report.js';
import type { ReportModel } from './build.js';
import { commentText, formatSites, partName } from './messages.js';

export interface CommentInput {
  diff: DiffResult;
  /** The head checked against the head's requirements (`buildReport` in mode `diff`). */
  head: ReportModel;
  /** The requirements file as the config names it. */
  requirementsFile: string;
}

/** Sites shown per change before "and N more". */
const MAX_SITES = 3;

/** A table cell: a pipe or a line break would end the cell; `<` could open HTML. */
const cell = (text: string) =>
  text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/\r?\n/g, ' ');

function sitesText(sites: readonly Location[]): string {
  const seen = new Map(sites.map((s) => [`${s.file}:${s.line}`, s]));
  const unique = [...seen.values()];
  return commentText.moreSites(
    formatSites(unique.slice(0, MAX_SITES)),
    Math.max(0, unique.length - MAX_SITES),
  );
}

/** Catalog sites are repository-relative already (spec 6.3.1). */
const catalogSite = (s: SourceSite): Location => ({ file: s.file, line: s.line });

/** Whether a finding on the head is explained by a catalog change. */
export function explains(c: CatalogChange, f: Finding): boolean {
  switch (c.kind) {
    case 'event-added':
      return false;
    case 'event-removed':
      return f.event === c.event;
    case 'event-renamed':
      return f.event === c.from;
    case 'property-removed':
      return (
        f.check !== 'event-has-call-site' &&
        f.property === c.property &&
        (c.event === null || f.event === undefined || f.event === c.event)
      );
    case 'values-narrowed':
      return (
        f.check === 'value-is-reachable' &&
        f.property === c.property &&
        (c.event === null || f.event === undefined || f.event === c.event)
      );
  }
}

const breaking = (f: Finding) => f.effect !== 'info' && f.effect !== 'unknown';

function tileCell(tile: ReportTile, change: TileChange, first: Finding | undefined): string {
  if (first !== undefined && change.head === 'degraded' && first.path.startsWith('breakdown['))
    return commentText.tile(tile.kind, tile.title, commentText.noneBucket(change.base));
  const part =
    first !== undefined && (change.head === 'dead' || change.head === 'partly-dead')
      ? partName(first.path, tile.kind)
      : undefined;
  return commentText.tile(
    tile.kind,
    tile.title,
    commentText.verdict(change.head, change.base, part),
  );
}

const alertCell = (a: AlertChange) => commentText.alert(a.name ?? a.id, a.head);

function changeText(c: CatalogChange, found: Location[]): string {
  const own = (sites: readonly SourceSite[]) => sitesText(sites.map(catalogSite));
  switch (c.kind) {
    case 'event-renamed':
      return commentText.renamed(c.from, c.to, own(c.sites));
    case 'event-removed':
      return commentText.removed(c.event, own(c.sites));
    case 'property-removed':
      return commentText.propertyRemoved(c.event, c.property, sitesText(found));
    case 'values-narrowed':
      return commentText.valuesNarrowed(c.event, c.property, c.removed, sitesText(found));
    case 'event-added':
      return '';
  }
}

export interface CommentRow {
  change: string;
  breaks: string[];
}

/** One row per catalog change with what it breaks, then the breaks no one change explains. */
export function commentRows(input: CommentInput): CommentRow[] {
  const { diff, head } = input;
  const tiles = new Map(head.report.tiles.map((t) => [t.id, t]));
  const alerts = new Map(head.report.alerts.map((a) => [a.id, a]));
  const placed = new Set<string>();
  const out: CommentRow[] = [];
  for (const c of diff.catalog) {
    if (c.kind === 'event-added') continue;
    const breaks: string[] = [];
    const broken = new Set<string>();
    const found: Location[] = [];
    for (const w of diff.worse) {
      const tile = tiles.get(w.id);
      if (tile === undefined) continue;
      const hits = tile.findings.filter((f) => breaking(f) && explains(c, f));
      if (hits.length === 0) continue;
      breaks.push(tileCell(tile, w, hits[0]));
      broken.add(w.id);
      placed.add(w.id);
      for (const f of hits) found.push(...f.sites);
    }
    for (const a of diff.alerts.worse) {
      const viaFinding = (alerts.get(a.id)?.findings ?? []).some((f) => explains(c, f));
      if (!broken.has(a.tile) && !viaFinding) continue;
      breaks.push(alertCell(a));
      placed.add(a.id);
    }
    if (breaks.length > 0) out.push({ change: changeText(c, found), breaks });
  }
  // Breaks no single catalog change explains, such as an event gone from one platform only.
  const rest = [
    ...diff.worse
      .filter((w) => !placed.has(w.id))
      .map((w) => {
        const tile = tiles.get(w.id);
        return tile === undefined
          ? commentText.tile('other', w.title, commentText.verdict(w.head, w.base))
          : tileCell(tile, w, tile.findings.find(breaking));
      }),
    ...diff.alerts.worse.filter((a) => !placed.has(a.id)).map(alertCell),
  ];
  if (rest.length > 0) out.push({ change: commentText.otherChanges, breaks: rest });
  return out;
}

/** What the change fixes: tiles and alerts. */
export function fixedItems(input: CommentInput): string[] {
  const tiles = new Map(input.head.report.tiles.map((t) => [t.id, t]));
  return [
    ...input.diff.fixed.map((c) =>
      commentText.fixedTile(tiles.get(c.id)?.kind ?? 'other', c.title, c.base, c.head),
    ),
    ...input.diff.alerts.fixed.map((a) => commentText.fixedAlert(a.name ?? a.id, a.base)),
  ];
}

/** The PR comment, starting with the hidden marker and ending with the closing sentence (G11). */
export function renderComment(input: CommentInput): string {
  const { diff, head } = input;
  const report = head.report;
  const lines = [
    commentText.marker,
    commentText.title(diff.worse.length, diff.alerts.worse.length),
  ];

  const table = commentRows(input);
  if (table.length > 0) {
    lines.push('', ...commentText.tableHead);
    for (const row of table)
      row.breaks.forEach((b, i) =>
        lines.push(i === 0 ? `| ${cell(row.change)} | ${cell(b)} |` : `| | ${cell(b)} |`),
      );
  }

  const fixed = fixedItems(input);
  if (fixed.length > 0) lines.push('', commentText.fixed(fixed));

  lines.push('', commentNotes(input).join(' '));
  lines.push(commentText.footer(report.tool));
  return `${lines.join('\n')}\n`;
}

/** The sentences under the table: what was checked, counts that were already so, unknowns (G11). */
export function commentNotes(input: CommentInput): string[] {
  const { diff, head } = input;
  const report = head.report;
  const open = head.sources.reduce((n, s) => n + s.callSites - s.literalNameSites, 0);
  const requirements = diff.requirements;
  return [
    commentText.checkedAgainst(input.requirementsFile, report.requirements.pulledAt),
    ...(diff.alreadyBroken > 0 ? [commentText.alreadyBroken(diff.alreadyBroken, diff.failOn)] : []),
    commentText.openSites(open),
    commentText.unknownParts(report.summary.unknownParts),
    ...(diff.changed.length > 0 ? [commentText.notCheckedMoves(diff.changed.length)] : []),
    ...(requirements.status === 'changed' && requirements.tiles.length > 0
      ? [commentText.requirementsChanged(requirements.tiles.length)]
      : []),
    ...(requirements.status === 'new' ? [commentText.requirementsNew] : []),
  ];
}
