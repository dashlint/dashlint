// From the check results to the `dashlint.report/1` object every renderer starts from (spec 6.9),
// plus what the text and HTML renderers print around it: sources, coverage and tile notes. Messages
// come from messages.ts only (spec 6.9.7). Choices the spec leaves open: ADR-048.
import type { AlertCheckResult, AlertFinding } from '../check/alerts.js';
import type { CheckContext } from '../check/checks/types.js';
import { eventFacts } from '../check/facts.js';
import type { IgnoreOutcome, IgnoreWarning } from '../check/ignore.js';
import type { TileResult } from '../check/verdicts.js';
import type { Catalog } from '../formats/catalog.js';
import { REPORT_SCHEMA } from '../formats/report.js';
import type {
  Finding,
  NotArriving,
  Report,
  ReportAlert,
  ReportMode,
  ReportSummary,
  ReportTile,
  UnknownPart,
} from '../formats/report.js';
import type { Requirements, Tile } from '../formats/requirements.js';
import { alertMessage, findingMessage, reasonText, reportText } from './messages.js';

export interface BuildInput {
  tool: string;
  mode: ReportMode;
  requirements: Requirements;
  catalogs: readonly Catalog[];
  ctx: CheckContext;
  /** The tile and alert results with the ignore list applied (T6.6). */
  outcome: IgnoreOutcome;
}

export interface SourceSummary {
  name: string;
  platforms: string[];
  callSites: number;
  literalNameSites: number;
  openSites: number;
}

export interface ReportModel {
  report: Report;
  sources: SourceSummary[];
  /** Every platform the catalogs cover, sorted. */
  platforms: string[];
  dashboards: { id: string; name: string }[];
  /** Per tile id: the notes printed after its title. */
  notes: Record<string, string[]>;
  /** The observed window, when PostHog data was read. */
  windowDays?: number;
  warnings: IgnoreWarning[];
}

const reportFinding = (f: TileResult['findings'][number], tile: Tile): Finding => ({
  check: f.check,
  path: f.path,
  effect: f.effect,
  ...(f.event === undefined ? {} : { event: f.event }),
  ...(f.property === undefined ? {} : { property: f.property }),
  ...(f.values === undefined ? {} : { values: [...f.values] }),
  code: f.code,
  ...(f.observed === undefined ? {} : { observed: f.observed }),
  sites: f.sites.map((s) => ({ file: s.file, line: s.line })),
  ...(f.hint === undefined ? {} : { hint: { ...f.hint } }),
  message: findingMessage(f, tile.kind),
});

const alertFinding = (f: AlertFinding): Finding => ({
  check: f.check,
  path: f.path,
  code: f.code,
  sites: f.sites.map((s) => ({ file: s.file, line: s.line })),
  message: alertMessage(f),
});

function unknownParts(r: TileResult): UnknownPart[] {
  const parts = r.unknownParts.map((p) => ({
    path: p.path,
    reason: p.reasons.length === 0 ? 'unknown' : p.reasons.map(reasonText).join('; '),
  }));
  if (parts.length === 0 && r.reasons !== undefined && r.reasons.length > 0)
    parts.push({ path: '', reason: r.reasons.map(reasonText).join('; ') });
  return parts;
}

function tileNotes(tile: Tile, r: TileResult, alerts: readonly AlertCheckResult[]): string[] {
  const notes: string[] = [];
  if (r.verdict === 'partly-dead' && r.deadFrom !== undefined)
    notes.push(reportText.deadSteps(r.deadFrom, (tile.series ?? []).length));
  if (r.verdict === 'partly-dead' && tile.kind === 'retention')
    notes.push(reportText.retentionZero);
  if (r.verdict === 'not-checked') {
    const kind = reportText.kindNotChecked(tile.kind);
    if (kind !== undefined) notes.push(kind);
  } else if (r.unknownParts.length > 0)
    notes.push(reportText.partsNotChecked(r.unknownParts.length));
  for (const a of alerts) {
    if (a.tile !== tile.id || a.result === 'ok' || a.result === 'not-checked') continue;
    notes.push(reportText.alertNote(a.name ?? a.id, a.result));
  }
  return notes;
}

function notArriving(ctx: CheckContext, requirements: Requirements): NotArriving[] {
  const out: NotArriving[] = [];
  for (const event of [...ctx.index.events].sort()) {
    const facts = eventFacts(ctx.facts, event);
    const sites = ctx.index.sites(event);
    if (facts.notArriving === undefined || sites.length === 0) continue;
    const seen = requirements.observed?.events[event];
    const enforcement = seen?.enforcement;
    out.push({
      event,
      sites: sites.map((s) => ({ file: s.file, line: s.line })),
      lastSeenAt: seen?.lastSeenAt ?? null,
      ...(enforcement === undefined ? {} : { enforcement }),
    });
  }
  return out;
}

/** The report and what the renderers print around it. */
export function buildReport(input: BuildInput): ReportModel {
  const { requirements, outcome } = input;
  const byId = new Map(requirements.tiles.map((t) => [t.id, t]));
  const alerts = outcome.alerts.filter((a) => a.ignored === undefined).map((a) => a.result);

  const tiles: ReportTile[] = [];
  const notes: Record<string, string[]> = {};
  for (const { result, verdict } of outcome.tiles) {
    const tile = byId.get(result.id) as Tile;
    tiles.push({
      id: tile.id,
      title: tile.title,
      ...(tile.url === undefined ? {} : { url: tile.url }),
      dashboards: [...(tile.dashboards ?? [])],
      kind: tile.kind,
      verdict,
      platforms: [...result.platforms],
      findings: result.findings.map((f) => reportFinding(f, tile)),
      unknownParts: verdict === 'ignored' ? [] : unknownParts(result),
    });
    notes[tile.id] = verdict === 'ignored' ? [] : tileNotes(tile, result, alerts);
  }

  const reportAlerts: ReportAlert[] = alerts.map((a) => ({
    id: a.id,
    ...(a.name === undefined ? {} : { name: a.name }),
    tile: a.tile,
    result: a.result,
    state: a.state,
    ...(a.enabled === undefined ? {} : { enabled: a.enabled }),
    ...(a.findings.length === 0 ? {} : { findings: a.findings.map(alertFinding) }),
  }));

  const count = (v: ReportTile['verdict']) => tiles.filter((t) => t.verdict === v).length;
  const countAlerts = (r: ReportAlert['result']) => alerts.filter((a) => a.result === r).length;
  const summary: ReportSummary = {
    tiles: tiles.length,
    live: count('live'),
    dead: count('dead'),
    partlyDead: count('partly-dead'),
    degraded: count('degraded'),
    onePlatform: count('one-platform'),
    notChecked: count('not-checked'),
    ignored: count('ignored'),
    unknownParts: tiles.reduce((n, t) => n + t.unknownParts.length, 0),
    alerts: {
      checked: alerts.filter((a) => a.result !== 'not-checked').length,
      canNeverFire: countAlerts('can-never-fire'),
      firesEveryCheck: countAlerts('fires-every-check'),
      invalidTarget: countAlerts('invalid-target'),
    },
  };

  const src = requirements.source;
  const report: Report = {
    schema: REPORT_SCHEMA,
    tool: input.tool,
    mode: input.mode,
    requirements: {
      platform: src.platform,
      ...(src.project === undefined ? {} : { project: src.project }),
      ...(src.pulledAt === undefined ? {} : { pulledAt: src.pulledAt }),
      observed: requirements.observed !== undefined,
    },
    catalogs: input.catalogs.map((c) => ({
      source: c.source.name,
      commit: c.source.commit,
      nameResolutionRate: c.coverage.nameResolutionRate,
    })),
    summary,
    tiles,
    alerts: reportAlerts,
    notArriving: requirements.observed === undefined ? [] : notArriving(input.ctx, requirements),
  };

  return {
    report,
    sources: input.catalogs.map((c) => ({
      name: c.source.name,
      platforms: [...c.source.platforms],
      callSites: c.coverage.callSites,
      literalNameSites: c.coverage.literalNameSites,
      openSites: c.coverage.openSites,
    })),
    platforms: [...new Set(input.catalogs.flatMap((c) => c.source.platforms))].sort(),
    dashboards: (requirements.dashboards ?? []).map((d) => ({ id: d.id, name: d.name ?? d.id })),
    notes,
    ...(requirements.observed === undefined
      ? {}
      : { windowDays: requirements.observed.windowDays }),
    warnings: [...outcome.warnings],
  };
}
