// Every user-facing string lives here (spec §6.9.7); scripts/copy-check.mjs checks this file.
import type { AlertFinding } from '../check/alerts.js';
import type { CheckFinding } from '../check/checks/types.js';
import type { JsonScalar } from '../formats/catalog.js';
import type { AlertResult, Location, TileKind, Verdict } from '../formats/report.js';

// G11: every report ends with this sentence.
export const CLOSING_SENTENCE =
  'A clean result means nothing dashlint can see is broken, not that every number is right.';

const code = (name: string) => `\`${name}\``;

/** A filter value as the user typed it: strings quoted, other JSON values as written. */
export const formatValue = (v: JsonScalar): string =>
  typeof v === 'string' ? JSON.stringify(v) : String(v);

/** "a", "a or b", "a, b or c". */
export function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] as string}`;
}

/** "a", "a and b", "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const formatSite = (s: Location) => `${s.file}:${s.line}`;
export const formatSites = (sites: readonly Location[]) => sites.map(formatSite).join(' · ');

/** `key` = "a", `key` is not "a", `key` contains "a", or the operator as PostHog names it. */
export function filterPhrase(key: string, op: string | undefined, values: readonly JsonScalar[]) {
  const vs = orList(values.map(formatValue));
  switch (op) {
    case 'exact':
      return `${code(key)} = ${vs}`;
    case 'is_not':
      return `${code(key)} is not ${vs}`;
    case 'icontains':
      return `${code(key)} contains ${vs}`;
    case 'not_icontains':
      return `${code(key)} does not contain ${vs}`;
    case 'is_set':
      return `${code(key)} is set`;
    case 'is_not_set':
      return `${code(key)} is not set`;
    case undefined:
      return code(key);
    default:
      return values.length === 0 ? `${code(key)} ${op}` : `${code(key)} ${op} ${vs}`;
  }
}

/** Where a finding sits, from its path: "step 3" in a funnel, "formula 1", or nothing. */
export function partName(path: string, kind: TileKind): string | undefined {
  const series = /^series\[(\d+)\]/.exec(path);
  if (series !== null && kind === 'funnels') return `step ${Number(series[1]) + 1}`;
  if (path.startsWith('exclusions[')) return 'the exclusion';
  if (path.startsWith('retention.target')) return 'the target event';
  if (path.startsWith('retention.returning')) return 'the returning event';
  return undefined;
}

// The 6.7.1 bases of a "no", as a clause about an event or a property on it.
function eventNo(event: string, basis: string | undefined): string {
  switch (basis) {
    case 'high':
      return `queries ${code(event)}: no code sends it and PostHog has never seen it`;
    case 'not-defined':
      return `queries ${code(event)}: PostHog has no definition of it, so it has never arrived`;
    default:
      return `queries ${code(event)}: no code sends it`;
  }
}

function propertyNo(f: CheckFinding, closest: string | undefined): string {
  const key = f.property as string;
  const instead = closest === undefined ? '' : ` (they send ${code(closest)})`;
  if (f.detail.scope === 'person') {
    const setter = closest === undefined ? '' : ` (it sets ${code(closest)})`;
    if (f.detail.basis === 'observed')
      return `PostHog has never seen the person property ${code(key)}`;
    const neverSeen =
      f.detail.basis === 'high' ? `, and PostHog has never seen it on a person` : '';
    return `no code sets the person property ${code(key)}${setter}${neverSeen}`;
  }
  const on = f.event === undefined ? 'any event' : code(f.event);
  if (f.detail.basis === 'observed') return `PostHog has never seen ${code(key)} on ${on}`;
  const neverSeen =
    f.detail.basis === 'high' ? `, and PostHog has never seen ${code(key)} on that event` : '';
  return `no call site sends ${code(key)} with ${on}${instead}${neverSeen}`;
}

function breakdownMessage(f: CheckFinding, closest: string | undefined): string {
  const key = code(f.property as string);
  const events = (f.detail.missingOn ?? (f.event === undefined ? [] : [f.event])).map(code);
  if (f.effect === 'info') {
    if (f.detail.presence === 'sometimes' && events.length === 0)
      return `breaks down by ${key}, which only some call sites send: their other rows land in one "(none)" bucket`;
    return `breaks down by ${key}, which ${orList(events)} never sends: those rows land in one "(none)" bucket`;
  }
  const instead = closest === undefined ? '' : ` (they send ${code(closest)})`;
  const of = events.length === 0 ? 'any event' : orList(events);
  return `breaks down by ${key}, which no call site of ${of} sends${instead}: every row lands in one "(none)" bucket`;
}

function valueMessage(f: CheckFinding, where: string | undefined): string {
  const key = f.property as string;
  const values = f.values ?? [];
  const reachable = f.hint?.reachableValues ?? [];
  const unreachable = f.detail.unreachable ?? [];
  const can = orList(reachable.map(formatValue));
  const prefix = where === undefined ? '' : `${where} `;
  if (f.detail.op === 'is_not')
    return `${prefix}filters out ${filterPhrase(key, 'exact', values)}, but the code never sends ${orList(unreachable.map(formatValue))}, so that part of the filter has no effect`;
  if (f.effect === 'dead' || unreachable.length === values.length)
    return `${prefix}filters ${filterPhrase(key, f.detail.op, values)}, but the code can only send ${can}`;
  return `${prefix}filters ${filterPhrase(key, f.detail.op, values)}, but the code never sends ${orList(unreachable.map(formatValue))}; it can only send ${can}`;
}

/** One finding as the report's `message` (spec 6.9.7): event, property or value, closest, why. */
export function findingMessage(f: CheckFinding, kind: TileKind): string {
  const where = partName(f.path, kind);
  const prefix = where === undefined ? '' : `${where} `;
  if (f.check === 'event-has-call-site') {
    const event = f.event as string;
    if (f.detail.producedElsewhere === true)
      return `${prefix}queries ${code(event)}, which no code here sends, but PostHog receives it: something else produces it (a server, a pipeline or another repository)`;
    const closest = f.hint?.closestEvent;
    const hint = closest === undefined ? '' : `; closest event in code: ${code(closest)}`;
    return `${prefix}${eventNo(event, f.detail.basis)}${hint}`;
  }
  if (f.check === 'value-is-reachable') return valueMessage(f, where);
  const closest = f.hint?.closestProperty;
  const key = f.property as string;
  if (f.detail.role === 'breakdown') return breakdownMessage(f, closest);
  if (f.detail.producedElsewhere === true) {
    const on = f.event === undefined ? '' : ` on ${code(f.event)}`;
    return `${prefix}uses ${code(key)}${on}, which no code here sends, but PostHog receives it: something else produces it`;
  }
  const no = propertyNo(f, closest);
  if (f.detail.role === 'math-property') return `${prefix}aggregates ${code(key)}, but ${no}`;
  if (f.effect === 'degraded' || f.detail.op === 'is_not' || f.detail.op === 'is_not_set')
    return `${prefix}filters out ${filterPhrase(key, f.detail.op, f.values ?? [])}, but ${no}, so the filter has no effect`;
  return `${prefix}filters on ${filterPhrase(key, f.detail.op, f.values ?? [])}, but ${no}`;
}

const TARGET_NOUN = { formulas: 'formula', series: 'series', steps: 'step' } as const;

function targetName(f: AlertFinding): string {
  const t = f.detail.target;
  if (!('index' in t)) return 'its query';
  const noun = t.kind === 'funnel-step' ? 'step' : t.kind;
  return `${noun} ${t.index + 1}`;
}

/** One alert finding as the report's `message`. */
export function alertMessage(f: AlertFinding): string {
  const d = f.detail;
  if (d.result === 'invalid-target') {
    const of = d.of ?? 'series';
    const count = d.count ?? 0;
    return `watches ${targetName(f)}, but the insight has ${plural(count, TARGET_NOUN[of], of === 'series' ? 'series' : `${TARGET_NOUN[of]}s`)}`;
  }
  const watched =
    d.watches === 'every-row'
      ? 'every breakdown row'
      : d.watches === 'funnel'
        ? 'the funnel'
        : targetName(f);
  const condition = d.condition === undefined ? '' : `, under a ${code(d.condition)} condition`;
  if (d.result === 'fires-every-check')
    return `fires on every check: it watches ${watched}, which is always zero, under a lower bound`;
  return `can never fire: it watches ${watched}, which is always zero${condition}`;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  live: 'LIVE',
  dead: 'DEAD',
  'partly-dead': 'PARTLY DEAD',
  degraded: 'DEGRADED',
  'one-platform': 'ONE PLATFORM',
  'not-checked': 'NOT CHECKED',
  ignored: 'IGNORED',
};

const KIND_NAME: Partial<Record<TileKind, string>> = {
  sql: 'SQL insight',
  paths: 'paths insight',
  other: 'an insight kind dashlint does not check',
};

// Reason codes from the checks and verdicts (src/check), as words. A reason with no entry here is
// printed as it is (requirements can carry the platform's own reason text).
const REASONS: Record<string, string> = {
  'kind-not-checked': 'an insight kind dashlint does not check',
  'no-catalog': 'no catalog to check against',
  'open-event-name': 'some event names in code are not literal, so any name may be sent',
  'conditional-builtin': 'a builtin the SDK sends only under init options dashlint cannot read',
  'unknown-builtin-table': 'an SDK version with no builtins table',
  'uncitable-name': 'a builtin name dashlint cannot cite a source for',
  'event-not-sent': 'the event is not sent',
  'open-properties': 'some call sites send properties dashlint cannot read',
  'open-super-properties': 'some super properties are set from values dashlint cannot read',
  'open-person-properties': 'some person properties are set from values dashlint cannot read',
  'crashed-file': 'a file dashlint could not read',
  'kind-cut': 'this insight kind is not checked in this release',
  'no-parts': 'no series, steps or entities to check',
  'warehouse-node': 'a data warehouse series',
  'and-group': 'an AND group of events',
  'no-action-steps': 'an action with no steps',
  'action-step-unsupported': 'an action step matches by URL, selector or text',
  'dashboard-filters-differ': 'its dashboards apply different filters',
  'formula-not-parsed': 'a formula dashlint cannot read',
  'formula-unknown-series': 'a formula names a series the insight does not have',
  'formula-series-unknown': 'a formula over a series that is not checked',
  'low-name-resolution': 'too few event names in code are literal (below 70%)',
  'person-properties-not-observed': 'person properties were not read from PostHog',
  'value-not-comparable': 'a value dashlint cannot compare',
  'regex-values': 'a regular expression filter',
  'no-values': 'a filter with no values',
  'several-icontains-values': 'a "contains" filter with several values',
  'scope-not-checked': 'a property scope dashlint does not check',
  'all-events': 'a filter on every event',
  'operator-not-checked': 'a filter operator dashlint does not check',
  'person-math-property': 'a math property on persons',
  'no-live-event': 'no live event to break down',
  'alert-tile-missing': 'its insight is not in the snapshot',
  'alert-target-hogql': 'a HogQL alert',
  'alert-target-metrics': 'a metrics alert',
  'alert-target-unread': 'its target was not read',
  'alert-target-mismatch': 'its target does not match the insight',
  'alert-target-range-unknown': 'the size of its target is not known',
  'alert-funnel-view': 'a funnel view alerts do not read',
  'alert-funnel-relative': 'a relative condition on a funnel',
  'alert-empty-funnel': 'a funnel whose first step is always zero',
  'alert-condition-detector': 'a detector condition',
  'alert-condition-unknown': 'a condition dashlint does not know',
};

export const reasonText = (reason: string): string => REASONS[reason] ?? reason;

const PLATFORM_NAME: Record<string, string> = {
  posthog: 'PostHog',
  mixpanel: 'Mixpanel',
  amplitude: 'Amplitude',
  segment: 'Segment',
};

/** `2026-12-18T09:12:00Z` as `2026-12-18 09:12 UTC`. */
export const formatPulledAt = (iso: string): string =>
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.test(iso)
    ? iso.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}).*$/, '$1 $2 UTC')
    : iso;

// The text report (src/report/text.ts, spec 6.9.3).
export const reportText = {
  header: (tool: string, platform: string, project?: number | string, pulledAt?: string) =>
    [
      `dashlint ${tool}`,
      `${PLATFORM_NAME[platform] ?? platform}${project === undefined ? '' : ` project ${project}`}`,
      ...(pulledAt === undefined ? [] : [`snapshot pulled ${formatPulledAt(pulledAt)}`]),
    ].join(' · '),
  noObserved: (platform: string) =>
    `${PLATFORM_NAME[platform] ?? platform} data: not read, so every finding rests on code alone`,
  sources: (sources: readonly { name: string; platforms: readonly string[] }[]) =>
    `Sources: ${sources.map((s) => `${s.name} (${s.platforms.join(', ')})`).join(' · ')}`,
  noSources: 'Sources: none',
  catalog: (callSites: number, literal: number, open: number) => {
    if (callSites === 0) return 'Catalog: 0 call sites';
    // Rounded down, so a rate is never shown higher than it is.
    const rate = Math.floor((literal / callSites) * 100);
    return `Catalog: ${plural(callSites, 'call site')}, ${literal} with literal event names (${rate}%), ${open} open`;
  },
  dashboard: (name: string, tiles: number, counts: string) =>
    `${name} (${plural(tiles, 'tile')}): ${counts}`,
  noDashboard: 'Not on a dashboard',
  counts: (c: {
    live: number;
    dead: number;
    partlyDead: number;
    degraded: number;
    onePlatform: number;
    notChecked: number;
    ignored: number;
  }) =>
    // Live and not checked (an unknown count, G11) always; the others when there are any.
    [
      `${c.live} live`,
      ...(c.dead > 0 ? [`${c.dead} dead`] : []),
      ...(c.partlyDead > 0 ? [`${c.partlyDead} partly dead`] : []),
      ...(c.degraded > 0 ? [`${c.degraded} degraded`] : []),
      ...(c.onePlatform > 0 ? [`${c.onePlatform} one platform`] : []),
      `${c.notChecked} not checked`,
      ...(c.ignored > 0 ? [`${c.ignored} ignored`] : []),
    ].join(' · '),
  verdictLabel: (v: Verdict) => VERDICT_LABEL[v],
  // Notes after a tile's title, in parentheses.
  deadSteps: (from: number, to: number) =>
    from === to ? `step ${from} is always zero` : `steps ${from} to ${to} are always zero`,
  retentionZero: 'retention is always 0%',
  kindNotChecked: (kind: TileKind) => KIND_NAME[kind],
  partsNotChecked: (n: number) => `${plural(n, 'part')} not checked`,
  alertNote: (name: string, result: string) =>
    result === 'can-never-fire'
      ? `alert "${name}" can never fire`
      : result === 'fires-every-check'
        ? `alert "${name}" fires on every check`
        : `alert "${name}" watches a part the insight does not have`,
  // Lines under a tile.
  onePlatform: (fed: readonly string[], missing: readonly string[]) =>
    `every event it counts is sent from ${andList(fed)} only; ${andList(missing)} ${missing.length === 1 ? 'has' : 'have'} no call site`,
  notCheckedReasons: (reasons: readonly string[]) =>
    `not checked: ${reasons.map(reasonText).join('; ')}`,
  unknownPart: (path: string, reasons: string) =>
    path === '' ? `not checked: ${reasons}` : `${path} not checked: ${reasons}`,
  // Sections after the tiles.
  notArriving: (
    event: string,
    sites: readonly Location[],
    windowDays: number,
    enforcement?: 'allow' | 'reject',
  ) =>
    `Not arriving: ${code(event)} is sent in code (${formatSites(sites)}) but PostHog has not seen it in ${windowDays} days${enforcement === 'reject' ? ' (its schema enforcement is set to reject)' : ''}.`,
  alerts: (checked: number, canNeverFire: number, firesEveryCheck: number, invalid: number) =>
    [
      `Alerts: ${checked} checked`,
      `${canNeverFire} can never fire`,
      ...(firesEveryCheck > 0 ? [`${firesEveryCheck} fire on every check`] : []),
      `${plural(invalid, 'invalid target')}`,
    ].join(' · '),
  alertLine: (name: string, message: string, state: string | null, enabled?: boolean) => {
    const shown = [...(enabled === false ? ['disabled'] : []), ...(state === null ? [] : [state])];
    return `alert "${name}" ${message}${shown.length === 0 ? '' : ` (PostHog shows: ${shown.join(', ')})`}`;
  },
  unknownTotal: (parts: number) =>
    `Unknown: ${plural(parts, 'part')} could not be decided and ${parts === 1 ? 'is' : 'are'} counted as not checked.`,
  ignoreExpired: (id: string, until: string) =>
    `Warning: the ignore entry for ${id} expired on ${until}; the tile is checked again.`,
  ignoreUnmatched: (id: string) =>
    `Warning: the ignore entry for ${id} matches nothing in the snapshot.`,
  written: (file: string) => `Report written to ${file}`,
  invalidReport: (errors: readonly string[]) =>
    `the report does not match dashlint.report/1: ${errors.join('; ')}`,
};

// The HTML report (src/report/html.ts, spec 6.9.5). Backticks become <code> there.
export const htmlText = {
  title: 'dashlint report',
  score: (live: number, tiles: number) =>
    `${live} of ${plural(tiles, 'tile')} ${tiles === 1 ? 'is' : 'are'} live`,
  summary: 'Summary',
  columns: {
    verdict: 'Verdict',
    tile: 'Tile',
    platforms: 'Platforms',
    reasons: 'Reasons',
    code: 'Code',
  },
  noPlatforms: 'none',
  filterLabel: 'Show tiles',
  filterAll: 'every verdict',
  alerts: 'Alerts',
  notArriving: 'Not arriving',
  notArrivingLine: (event: string, windowDays: number, enforcement?: 'allow' | 'reject') =>
    `${code(event)} is sent in code but PostHog has not seen it in ${windowDays} days${enforcement === 'reject' ? ' (its schema enforcement is set to reject)' : ''}.`,
  notArrivingNone: 'dashlint found no event that is sent in code but missing from PostHog.',
  notArrivingNotRead: 'PostHog data was not read, so arrival was not checked.',
  unknowns: 'Unknowns',
  warnings: 'Warnings',
};

const VERDICT_WORD: Record<Verdict, string> = {
  live: 'live',
  dead: 'dead',
  'partly-dead': 'partly dead',
  degraded: 'degraded',
  'one-platform': 'one platform',
  'not-checked': 'not checked',
  ignored: 'ignored',
};

const ALERT_WORD: Record<AlertResult, string> = {
  ok: 'ok',
  'can-never-fire': 'can never fire',
  'fires-every-check': 'fires on every check',
  'invalid-target': 'invalid target',
  'not-checked': 'not checked',
};

const TILE_NOUN: Partial<Record<TileKind, string>> = {
  trends: 'Trend',
  funnels: 'Funnel',
  retention: 'Retention',
  lifecycle: 'Lifecycle',
  stickiness: 'Stickiness',
  paths: 'Paths',
  sql: 'SQL insight',
};

const ALREADY: Record<string, string> = {
  dead: 'dead',
  'partly-dead': 'dead or partly dead',
  degraded: 'broken',
};

const at = (sites: string) => (sites === '' ? '' : ` (${sites})`);

// The PR comment (src/report/markdown.ts, spec 6.9.6). Cells are escaped by the renderer.
export const commentText = {
  marker: '<!-- dashlint:v1 -->',
  title: (tiles: number, alerts: number) =>
    tiles + alerts === 0
      ? '**dashlint: this PR breaks no tiles or alerts**'
      : `**dashlint: this PR would break ${andList([
          ...(tiles > 0 ? [plural(tiles, 'tile')] : []),
          ...(alerts > 0 ? [plural(alerts, 'alert')] : []),
        ])}**`,
  tableHead: ['| Change | Breaks |', '|---|---|'],
  renamed: (from: string, to: string, sites: string) =>
    `${code(from)} renamed to ${code(to)}${at(sites)}`,
  removed: (event: string, sites: string) => `${code(event)} removed${at(sites)}`,
  propertyRemoved: (event: string | null, property: string, sites: string) =>
    event === null
      ? `super property ${code(property)} removed${at(sites)}`
      : `${code(property)} removed from ${code(event)}${at(sites)}`,
  valuesNarrowed: (
    event: string | null,
    property: string,
    removed: readonly JsonScalar[],
    sites: string,
  ) =>
    `${code(property)}${event === null ? '' : ` on ${code(event)}`} no longer sends ${orList(removed.map(formatValue))}${at(sites)}`,
  otherChanges: 'Other changes in this PR',
  moreSites: (sites: string, more: number) => (more === 0 ? sites : `${sites} and ${more} more`),
  tile: (kind: TileKind, title: string, detail: string) =>
    `${TILE_NOUN[kind] === undefined ? '' : `${TILE_NOUN[kind]} `}"${title}" (${detail})`,
  verdict: (head: Verdict, base: Verdict, part?: string) =>
    `${part === undefined ? '' : `${part}: `}${VERDICT_WORD[head]}${base === 'live' ? '' : `, was ${VERDICT_WORD[base]}`}`,
  noneBucket: (base: Verdict) =>
    `degraded: one "(none)" bucket${base === 'live' ? '' : `, was ${VERDICT_WORD[base]}`}`,
  alert: (name: string, result: AlertResult) => `Alert "${name}" (${ALERT_WORD[result]})`,
  fixedTile: (kind: TileKind, title: string, base: Verdict, head: Verdict) =>
    `${TILE_NOUN[kind] === undefined ? '' : `${TILE_NOUN[kind]} `}"${title}" (${VERDICT_WORD[head]}, was ${VERDICT_WORD[base]})`,
  fixedAlert: (name: string, base: AlertResult) => `Alert "${name}" (was ${ALERT_WORD[base]})`,
  fixed: (items: readonly string[]) => `Fixed by this PR: ${items.join(', ')}.`,
  checkedAgainst: (file: string, pulledAt?: string) =>
    `Checked against ${code(file)}${pulledAt === undefined ? '' : ` (pulled ${pulledAt.slice(0, 10)})`}.`,
  alreadyBroken: (n: number, failOn: string) =>
    `${plural(n, 'tile')} ${n === 1 ? 'was' : 'were'} already ${ALREADY[failOn] ?? 'broken'} before this PR.`,
  // Unknown counts are always printed (G11).
  openSites: (n: number) =>
    `${plural(n, 'call site')} ${n === 1 ? 'has' : 'have'} non-literal event names.`,
  unknownParts: (n: number) => `${plural(n, 'part')} could not be decided.`,
  notCheckedMoves: (n: number) => `${plural(n, 'tile')} moved to or from not checked.`,
  requirementsChanged: (n: number) =>
    `This PR also changes the requirements file; ${plural(n, 'tile')} changed because of that (information, never a failure).`,
  requirementsNew: 'This PR adds the requirements file, so every tile is new.',
  footer: (tool: string) =>
    `<sub>dashlint ${tool} · ${CLOSING_SENTENCE.charAt(0).toLowerCase()}${CLOSING_SENTENCE.slice(1, -1)}</sub>`,
};

// `dashlint diff --format text` (src/report/diff-text.ts): the comment's rows and sentences as text.
export const diffText = {
  header: (tool: string, base: string | null, head: string | null) =>
    `dashlint ${tool} · diff ${base === null ? 'the base catalog' : base.slice(0, 7)} to ${head === null ? 'the working tree' : head.slice(0, 7)}`,
  title: (tiles: number, alerts: number) =>
    tiles + alerts === 0
      ? 'This change breaks no tiles or alerts.'
      : `This change would break ${andList([
          ...(tiles > 0 ? [plural(tiles, 'tile')] : []),
          ...(alerts > 0 ? [plural(alerts, 'alert')] : []),
        ])}.`,
  breaks: (what: string) => `breaks ${what}`,
  result: (fails: number, failOn: string) =>
    failOn === 'never'
      ? 'Result: failOn is never, so this change does not fail the run.'
      : fails === 0
        ? `Result: nothing newly ${ALREADY[failOn] ?? 'broken'}, so this change does not fail the run.`
        : `Result: ${plural(fails, 'tile')} newly ${ALREADY[failOn] ?? 'broken'}, so this change fails the run.`,
};

// Format validation (src/formats/validate.ts). `path` is a JSON pointer into the file.
export const validation = {
  error: (path: string, message: string) => `${path === '' ? '(top level)' : path}: ${message}`,
  errorAt: (line: number, path: string, message: string) =>
    `line ${line}${path === '' ? '' : `, ${path}`}: ${message}`,
  yamlTag: (tag: string) => `the tag ${tag} is not allowed; dashlint reads plain YAML only`,
  yamlDuplicateKey: (key: string) => `duplicate key "${key}"`,
  yamlSyntax: (detail: string) => `cannot be read as YAML: ${detail}`,
  notFinite: 'is not a finite number',
  schemaMismatch: 'does not match the schema',
  countAboveCallSites: (field: string) => `${field} is greater than callSites`,
  rateMismatch: (rate: number, literal: number, callSites: number) =>
    `nameResolutionRate ${rate} does not equal literalNameSites / callSites (${literal} / ${callSites})`,
  openSitesAboveSites: (openSites: number, sites: number) =>
    `openSites ${openSites} is greater than the number of sites (${sites})`,
  duplicateId: (id: string) => `duplicate id "${id}"`,
  duplicateRef: (ref: string) => `series ref ${ref} is used twice in this tile`,
  duplicateFormulaIndex: (index: number) => `formula index ${index} is used twice in this tile`,
  onlyOnKind: (field: string, kind: string) => `${field} is only allowed on ${kind} tiles`,
  retentionMissing: 'a retention tile needs retention.target and retention.returning',
  notCheckedReasonMissing: (kind: string) =>
    `a ${kind} tile is not checked and needs a notChecked entry for the whole tile with its reason`,
  exclusionSteps: (fromStep: number, toStep: number) =>
    `toStep ${toStep} must be greater than fromStep ${fromStep}`,
  undefinedEventField: (field: string) => `an event that is not defined cannot have ${field}`,
  seenAndNotSeen: (property: string) => `"${property}" is listed as both seen and not seen`,
};

// `dashlint pull` (src/adapters/posthog/pull.ts, src/cli/commands/pull.ts; spec 6.5, 6.8, 6.13).
export const pullMessages = {
  // Spec 6.8: a literal key in the config.
  literalKey: 'Put the key in an environment variable and write `key: env:NAME`.',
  noKey: (name: string) => `no PostHog key: the environment variable ${name} is not set or empty`,
  wrote: (file: string, tiles: number, dashboards: number, alerts: number) =>
    `pull: wrote ${file} (${tiles} tiles, ${dashboards} dashboards, ${alerts} alerts)`,
  // Spec 6.13: said on every pull that is not redacted.
  publicNames:
    'pull: this file holds your insight titles, dashboard names, alert names and filter values. ' +
    'If you commit it to a public repository, they become public. ' +
    'To replace titles with ids and drop the names, set `redact: true` under platforms.posthog.',
  redacted:
    'pull: redact is on: titles are replaced by ids and dashboard, alert and action names are left out. ' +
    'Filter values stay, because the checks need them; on a public repository they become public.',
  failed: (message: string) => `dashlint pull: ${message}`,
  bug: (message: string) => `dashlint pull: unexpected error: ${message}\n${BUG_REPORT}`,
  usage: 'Usage: dashlint pull [--out <file>] [--config <file>]',
  unknownFlag: (flag: string) => `unknown option ${flag}`,
  flagNeedsValue: (flag: string) => `${flag} needs a value`,
  configUnreadable: (file: string, detail: string) => `cannot read the config ${file}: ${detail}`,
  configInvalid: (file: string, error: string) => `${file}: ${error}`,
  configField: (path: string, expected: string) => `${path} must be ${expected}`,
  configMissing: (path: string) => `${path} is missing; pull needs it`,
  requirementsNotJson: (file: string) =>
    `requirements names ${file}; pull writes JSON only (a .yml or .yaml file is written by hand), so point requirements at a .json file`,
  hogqlRefused: (why: string) => `refused a HogQL query before sending it: ${why}`,
  hogqlUnexpected: (why: string) =>
    `the HogQL recency query (POST query/) gave an unexpected answer: ${why}`,
  hogqlAsking: (events: number) =>
    `pull: asking HogQL when the properties of ${events} event${events === 1 ? '' : 's'} last arrived (POST query/, aggregates only)`,
  cannotWrite: (file: string, detail: string) => `cannot write ${file}: ${detail}`,
  actionNotRead: (id: string) => `pull: action ${id} was not found; its tiles are not checked`,
  invalidOutput: (error: string) => `the pulled requirements do not validate: ${error}`,
};

// Spec 6.9.2: printed with every exit 3.
export const BUG_REPORT =
  'This is a bug in dashlint. Please report it at https://github.com/dashlint/dashlint/issues with the output above.';

// The command line and the config (src/cli/; spec 6.8, 6.9.1, 6.9.2).
export const cliMessages = {
  help: (version: string) => `dashlint ${version}

Usage: dashlint <command> [options]

Commands:
  init [--yes]
      find the apps that use an SDK and write dashlint.config.yml (--yes replaces one)
  extract [--source <name>] [--out <file>]
      write the catalog JSON of each source (no network)
  pull [--out <file>]
      write the requirements snapshot from PostHog (network: GET only)
  check [--catalog <file>]... [--requirements <file>]
        [--format text|json|html|markdown] [--out <file>] [--fail-on <level>]
      extract (unless catalogs are given) and check (no network)
  audit [--offline] [--out <file>] [--format html|json|text]
      pull (unless --offline), extract, check; the HTML report goes to dashlint-report.html
      and the text report to the terminal
  diff --base <git-ref|catalog.json> [--head <git-ref>] [--format text|json|markdown]
      what a change breaks: tiles newly broken at or above failOn fail (no network)

Options for every command:
  --config <file>   the config, default dashlint.config.yml
  --cwd <dir>       run as if started in <dir>
  --quiet           print only the result and errors
  --no-color        print no colors (dashlint prints none today)
  --version         print the version number
  --help            print this message

Exit codes: 0 nothing at or above failOn, 1 findings at or above failOn, 2 usage or config error,
3 a bug in dashlint, 4 pull failed.`,
  prefix: (command: string | undefined, message: string) =>
    `dashlint${command === undefined ? '' : ` ${command}`}: ${message}`,
  bug: (command: string | undefined, message: string) =>
    `dashlint${command === undefined ? '' : ` ${command}`}: unexpected error: ${message}\n${BUG_REPORT}`,
  noCommand:
    'name a command: init, extract, pull, check, audit or diff (dashlint --help lists them)',
  unknownCommand: (name: string, suggestion: string | undefined) =>
    `unknown command ${name}${suggestion === undefined ? '' : `; did you mean ${suggestion}?`}`,
  unknownFlag: (flag: string, suggestion: string | undefined) =>
    `unknown option ${flag}${suggestion === undefined ? '' : `; did you mean ${suggestion}?`}`,
  flagNeedsValue: (flag: string) => `${flag} needs a value`,
  flagTakesNoValue: (flag: string) => `${flag} takes no value`,
  flagTwice: (flag: string) => `${flag} is given twice`,
  flagChoice: (flag: string, value: string, choices: readonly string[]) =>
    `${flag} ${value} is not one of ${choices.join(', ')}`,
  positional: (arg: string) => `unexpected argument ${arg}`,
  configUnreadable: (file: string, detail: string) => `cannot read the config ${file}: ${detail}`,
  configAt: (file: string, line: number | undefined, message: string) =>
    `${file}: ${line === undefined ? '' : `line ${line}: `}${message}`,
  configField: (path: string, expected: string) => `${path} must be ${expected}`,
  configMissing: (path: string) => `${path} is missing`,
  configUnknownKey: (path: string, suggestion: string | undefined) =>
    `${path} is not a known key${suggestion === undefined ? '' : `; did you mean \`${suggestion}\`?`}`,
  configDuplicateSource: (name: string) => `two sources are named ${name}`,
  noConfig: (file: string, command: string) =>
    `no config at ${file}; write one (spec: dashlint.config.yml) or pass --config${command === 'check' ? ', or give both --catalog and --requirements' : ''}`,
  noSources: 'the config lists no sources; add one under sources',
  unknownSource: (name: string, suggestion: string | undefined) =>
    `no source is named ${name}${suggestion === undefined ? '' : `; did you mean ${suggestion}?`}`,
  sourcePathMissing: (name: string, path: string, dir: string) =>
    `source ${name}: path ${path} is not a folder inside ${dir}`,
  sourceTsconfigMissing: (name: string, tsconfig: string) =>
    `source ${name}: tsconfig ${tsconfig} not found`,
  outNeedsOneCatalog:
    '--out writes one catalog, and the config lists several sources; add --source <name>',
  fileUnreadable: (what: string, file: string, detail: string) =>
    `cannot read the ${what} ${file}: ${detail}`,
  fileInvalid: (file: string, error: string) => `${file}: ${error}`,
  noRequirements: (file: string) =>
    `no requirements file at ${file}; run dashlint pull, or write one by hand`,
  cannotWrite: (file: string, detail: string) => `cannot write ${file}: ${detail}`,
  extractFailed: (message: string) => `the extraction failed: ${message}`,
  descriptorsInvalid: (errors: string) =>
    `the SDK descriptors shipped with dashlint are invalid: ${errors}`,
  wroteCatalog: (file: string, source: string, events: number, rate: number) =>
    `extract: wrote ${file} (source ${source}, ${events} event${events === 1 ? '' : 's'}, name resolution ${Math.round(rate * 1000) / 10}%)`,
  wroteReport: (command: string, file: string) => `${command}: wrote ${file}`,
  // `dashlint diff` (src/cli/commands/diff.ts, spec 6.7.5).
  diffNeedsBase: '--base is missing; name the commit or the catalog file to compare with',
  diffNotGit: (dir: string) =>
    `${dir} is not in a git repository; diff --base <ref> compares two commits (or pass a catalog file as --base)`,
  diffHeadNeedsGit: '--head names a commit, so --base must name one too, not a catalog file',
  noRequirementsAt: (file: string, commit: string) =>
    `the head commit ${commit.slice(0, 7)} has no requirements file ${file}`,
  configExists: (file: string) =>
    `${file} already exists and was left as it is; pass --yes to replace it`,
  packageJsonUnreadable: (file: string) => `${file} is not readable JSON; it was skipped`,
  wroteConfig: (file: string, sources: string[]) =>
    sources.length === 0
      ? `init: wrote ${file} with no sources: no app here depends on an SDK dashlint describes; add one under sources`
      : `init: wrote ${file} with ${String(sources.length)} source${sources.length === 1 ? '' : 's'}: ${sources.join('; ')}. Set the PostHog project in it, then run dashlint pull`,
  markdownNeedsDiff:
    '--format markdown writes the pull request comment, which compares two commits; check prints text, json or html',
  warning: (command: string, message: string) => `${command}: ${message}`,
};

// SDK descriptors, their builtins and stubs (src/descriptors/loader.ts).
export const descriptorErrors = {
  inFile: (file: string, error: string) => `${file}: ${error}`,
  unreadable: (file: string, detail: string) => `cannot read ${file}: ${detail}`,
  memberOrHook: 'a call needs exactly one of member or hook',
  hookAlone: (key: string) => `a hook entry takes no other key, found ${key}`,
  onMissing: 'a member call needs on: the containers that declare it',
  noRole:
    'a member call needs a role: event, superProperties, identity, or personSet or personSetOnce',
  roleConflict: (a: string, b: string) => `${a} and ${b} cannot be on the same call`,
  onlyWithEvent: (key: string) => `${key} is only allowed on a call with event`,
  fallbackNeedsPersonSet: 'personSetFallback needs personSet',
  duplicateCall: (container: string, member: string) => `${container}.${member} is described twice`,
  duplicateHook: (hook: string) => `hook ${hook} is described twice`,
  packageNotDeclaredIn: (pkg: string) => `declaredIn must include the package ${pkg}`,
  verifiedOutsideRange: (verified: string, range: string) =>
    `verified version ${verified} is outside versions ${range}`,
  conditionShape:
    'a condition is always, { option, not }, { option, is } or { unknown }, with nothing else',
  duplicateName: (name: string) => `"${name}" is listed twice`,
  sdkMismatch: (found: string, expected: string) =>
    `sdk is ${found} but the descriptor is ${expected}`,
  duplicateSdk: (sdk: string) => `sdk ${sdk} is described by two descriptors`,
  ingestionCondition:
    'an ingestion row is always or { unknown }: the SDK init options cannot switch it',
  ingestionDuplicate: (name: string, builtins: string) => `"${name}" is also listed in ${builtins}`,
  stubPackageMissing: (pkg: string, stub: string) => `${stub} does not declare module "${pkg}"`,
  stubForeignModule: (module: string, pkg: string, stub: string) =>
    `${stub} declares module "${module}", which is not ${pkg} or one of its subpaths`,
  containerNotInStub: (container: string, stub: string) =>
    `container ${container} is not declared in ${stub}`,
  memberNotInStub: (member: string, container: string, stub: string) =>
    `member ${member} is not declared on ${container} in ${stub}`,
  hookNotInStub: (hook: string, stub: string) => `hook ${hook} is not declared in ${stub}`,
  componentNotInStub: (component: string, stub: string) =>
    `component ${component} is not declared in ${stub}`,
};
