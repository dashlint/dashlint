// `dashlint.report/1` (spec 6.9.4): the stable JSON report. The JSON Schema in
// schema/report.schema.json is the contract; these types mirror it.
import type { JsonScalar } from './catalog.js';

export const REPORT_SCHEMA = 'dashlint.report/1';

export type ReportMode = 'check' | 'audit' | 'diff';

export type TileKind =
  'trends' | 'funnels' | 'retention' | 'lifecycle' | 'stickiness' | 'paths' | 'sql' | 'other';

export type Verdict =
  'live' | 'dead' | 'partly-dead' | 'degraded' | 'one-platform' | 'not-checked' | 'ignored';

export type CheckId =
  | 'event-has-call-site'
  | 'property-is-sent'
  | 'value-is-reachable'
  | 'alert-target-valid'
  | 'alert-can-never-fire';

/** Three-valued code fact (G15). */
export type CodeFact = 'yes' | 'no' | 'unknown';

export type ObservedFact = 'seen' | 'notSeen' | 'unknown';

export type FindingEffect = 'dead' | 'degraded' | 'unknown' | 'info';

export type AlertResult =
  'ok' | 'can-never-fire' | 'fires-every-check' | 'invalid-target' | 'not-checked';

export interface Location {
  file: string;
  line: number;
}

export interface FindingHint {
  closestEvent?: string;
  closestProperty?: string;
  reachableValues?: JsonScalar[];
}

export interface Finding {
  check: CheckId;
  /** Where in the tile, such as `series[0].filters[0]`. */
  path: string;
  effect?: FindingEffect;
  event?: string;
  property?: string;
  values?: JsonScalar[];
  code: CodeFact;
  observed?: ObservedFact;
  sites: Location[];
  hint?: FindingHint;
  message: string;
}

export interface UnknownPart {
  path: string;
  reason: string;
}

export interface ReportTile {
  id: string;
  title: string;
  url?: string;
  dashboards: string[];
  kind: TileKind;
  verdict: Verdict;
  platforms: string[];
  findings: Finding[];
  unknownParts: UnknownPart[];
}

export interface ReportAlert {
  id: string;
  name?: string;
  tile: string;
  result: AlertResult;
  /** The alert's state as PostHog shows it, such as "Not firing" or "Errored". */
  state: string | null;
  enabled?: boolean;
  findings?: Finding[];
}

export interface NotArriving {
  event: string;
  sites: Location[];
  lastSeenAt: string | null;
  enforcement?: 'allow' | 'reject';
}

export interface ReportSummary {
  tiles: number;
  live: number;
  dead: number;
  partlyDead: number;
  degraded: number;
  onePlatform: number;
  notChecked: number;
  ignored: number;
  unknownParts: number;
  alerts: { checked: number; canNeverFire: number; firesEveryCheck: number; invalidTarget: number };
}

export interface Report {
  schema: typeof REPORT_SCHEMA;
  tool: string;
  mode: ReportMode;
  requirements: {
    platform: string;
    project?: number | string;
    pulledAt?: string;
    observed: boolean;
  };
  catalogs: { source: string; commit: string | null; nameResolutionRate: number }[];
  summary: ReportSummary;
  tiles: ReportTile[];
  alerts: ReportAlert[];
  notArriving: NotArriving[];
}
