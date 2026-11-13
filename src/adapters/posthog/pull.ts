// `dashlint pull` for PostHog (spec 6.5, T5.5): read a project's definitions through the client,
// normalise them, add observed data, stamp the pull and write canonical JSON. The same project read
// twice gives the same bytes apart from `source.pulledAt`: every list is sorted by the normalisers,
// observed data follows the requirements' own references, and the writer orders every key.
//
// `redact: true` (spec 6.13, cut-order item 2) replaces tile titles with their ids and leaves out
// dashboard, alert and action names (ADR-035). Filter values stay: the checks need them.
import { toCanonicalJson } from '../../formats/canonical.js';
import type { Requirements, SeriesNode } from '../../formats/requirements.js';
import { formatValidationErrors, validateRequirements } from '../../formats/validate.js';
import { pullMessages } from '../../report/messages.js';
import { PostHogClient, PullError, type ClientOptions } from './client.js';
import {
  actionIdsOf,
  actionLookup,
  normalizeInsights,
  referencesOf,
  withObserved,
} from './normalize/index.js';
import { isRecord } from './normalize/common.js';

/** The `platforms.posthog` settings `pull` uses, with the key already read from the environment. */
export interface PullSettings {
  host: string;
  project: number | string;
  key: string;
  /** `observedDays`; default 30. */
  observedDays?: number;
  redact?: boolean;
}

export interface PullOptions extends PullSettings {
  /** The dashlint version written as `source.tool`. */
  tool: string;
  now?: () => number;
  fetch?: ClientOptions['fetch'];
  sleep?: ClientOptions['sleep'];
  info?: (line: string) => void;
  debug?: (line: string) => void;
}

/** What `pull` read from PostHog, after the client dropped everything that is not a definition. */
export interface ProjectDefinitions {
  insights: unknown[];
  dashboards: unknown[];
  alerts: unknown[];
  actions: unknown[];
  eventDefinitions: unknown[];
  /** Per event with referenced event properties, its property definitions filtered by the event. */
  eventProperties: Map<string, unknown[]>;
  /** Absent when no tile references a person property. */
  personProperties?: unknown[];
}

/** A time as the requirements write it: UTC, whole seconds. */
export function pullTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function idOf(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  const id = row.id;
  return typeof id === 'number' || (typeof id === 'string' && id !== '') ? String(id) : undefined;
}

function eventPropertiesPath(event: string): string {
  return `property_definitions/?type=event&event_names=${encodeURIComponent(JSON.stringify([event]))}&filter_by_event_names=true`;
}

/**
 * Reads every definition `pull` needs, GET only: saved insights, dashboards (each one's tiles and
 * filters), alerts, the actions the tiles name, event definitions, and property definitions per
 * referenced event and for persons. An action PostHog no longer has (HTTP 404) is left unread, so
 * its nodes stay not checked; every other failure stops the pull.
 */
export async function readProject(
  client: PostHogClient,
  info: (line: string) => void = () => {},
): Promise<{ definitions: ProjectDefinitions; requirements: Requirements }> {
  // The client accepts only a numeric id; written as a number, as the format's example shows.
  const ctx = { host: client.host, project: Number(client.project) };
  const insights = await client.getAll('insights/?saved=true');
  const dashboardRows = await client.getAll('dashboards/');
  const dashboardIds = dashboardRows
    .filter((d) => !(isRecord(d) && d.deleted === true))
    .map(idOf)
    .filter((id): id is string => id !== undefined);
  const dashboards = await Promise.all(
    [...new Set(dashboardIds)].map((id) => client.get(`dashboards/${encodeURIComponent(id)}/`)),
  );
  const alerts = await client.getAll('alerts/');

  // Normalise once to learn which actions the tiles name, read them, then normalise with them.
  const first = normalizeInsights(insights, { ...ctx, dashboards, alerts });
  const actionBodies = await Promise.all(
    actionIdsOf(first).map(async (id) => {
      try {
        return await client.get(`actions/${encodeURIComponent(String(id))}/`);
      } catch (e) {
        if (e instanceof PullError && e.status === 404) {
          info(pullMessages.actionNotRead(String(id)));
          return undefined;
        }
        throw e;
      }
    }),
  );
  const actions = actionBodies.filter((b) => b !== undefined);
  const requirements = normalizeInsights(insights, {
    ...ctx,
    dashboards,
    alerts,
    actions: actionLookup(actions),
  });

  const refs = referencesOf(requirements);
  const eventDefinitions = await client.getAll('event_definitions/');
  const events = [...refs.eventProperties.keys()];
  const lists = await Promise.all(events.map((e) => client.getAll(eventPropertiesPath(e))));
  const eventProperties = new Map(events.map((e, i) => [e, lists[i] ?? []]));
  const personProperties =
    refs.personProperties.length > 0
      ? await client.getAll('property_definitions/?type=person')
      : undefined;

  return {
    definitions: {
      insights,
      dashboards,
      alerts,
      actions,
      eventDefinitions,
      eventProperties,
      ...(personProperties === undefined ? {} : { personProperties }),
    },
    requirements,
  };
}

function withoutName<T extends { name?: string }>(o: T): T {
  const copy = { ...o };
  delete copy.name;
  return copy;
}

function redactNode(node: SeriesNode): SeriesNode {
  return node.node === 'action' ? { ...node, action: withoutName(node.action) } : node;
}

/**
 * The requirements with every user-written name taken out (spec 6.13): a tile's title becomes its
 * id; dashboards, alerts and actions keep their ids and lose their names.
 */
export function redactRequirements(r: Requirements): Requirements {
  return {
    ...r,
    ...(r.dashboards === undefined ? {} : { dashboards: r.dashboards.map(withoutName) }),
    tiles: r.tiles.map((t) => ({
      ...t,
      title: t.id,
      ...(t.series === undefined ? {} : { series: t.series.map(redactNode) }),
      ...(t.exclusions === undefined ? {} : { exclusions: t.exclusions.map(redactNode) }),
      ...(t.retention === undefined
        ? {}
        : {
            retention: {
              target: redactNode(t.retention.target),
              returning: redactNode(t.retention.returning),
            },
          }),
    })),
    ...(r.alerts === undefined ? {} : { alerts: r.alerts.map(withoutName) }),
  };
}

/** Canonical JSON of requirements that validate; anything else is a bug in dashlint (exit 3). */
export function requirementsJson(r: Requirements): string {
  const result = validateRequirements(r);
  if (!result.ok)
    throw new PullError(
      pullMessages.invalidOutput(formatValidationErrors(result.errors).join('; ')),
      3,
    );
  return toCanonicalJson(result.value);
}

/** Reads the project and returns its requirements, stamped and (with `redact`) redacted. */
export async function pullRequirements(options: PullOptions): Promise<Requirements> {
  const now = options.now ?? Date.now;
  const info = options.info ?? ((line: string) => process.stderr.write(`${line}\n`));
  const client = new PostHogClient({
    host: options.host,
    project: options.project,
    key: options.key,
    info,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.debug ? { debug: options.debug } : {}),
    now,
  });
  const { definitions, requirements } = await readProject(client, info);
  const observed = withObserved(requirements, {
    ...(options.observedDays === undefined ? {} : { windowDays: options.observedDays }),
    eventDefinitions: definitions.eventDefinitions,
    eventProperties: definitions.eventProperties,
    ...(definitions.personProperties === undefined
      ? {}
      : { personProperties: definitions.personProperties }),
  });
  const stamped: Requirements = {
    ...observed,
    source: { ...observed.source, pulledAt: pullTime(now()), tool: options.tool },
  };
  return options.redact === true ? redactRequirements(stamped) : stamped;
}
