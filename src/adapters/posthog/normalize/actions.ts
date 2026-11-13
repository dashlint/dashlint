// PostHog actions (`actions/{id}/`, spec 6.5.1, 6.3.2): an action node's steps, each an event (or
// any event) with property filters. A step that also matches on the page URL, a link, an element's
// selector, tag or text records the matcher in `unsupported`: dashlint cannot see those in code, so
// that step is unknown in the checks (ADR-017).
import type {
  ActionNode,
  ActionStep,
  Requirements,
  SeriesNode,
} from '../../../formats/requirements.js';
import { NotCheckedList, filtersOf, isRecord, type ActionLookup } from './common.js';

type Action = ActionNode['action'];

// PostHog's step matchers besides event and properties (ActionStepJSON), in the order written.
// `*_matching` fields only say how a matcher compares, and `selector_regex` and `selector_warning`
// are derived from `selector`, so none of them is a matcher of its own.
const MATCHERS = ['url', 'href', 'selector', 'tag_name', 'text'] as const;

function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function step(raw: unknown): ActionStep {
  if (!isRecord(raw)) return { event: null, filters: [], unsupported: ['step'] };
  // PostHog matches a step's event only when it is set (a null or empty event is every event).
  const event = typeof raw.event === 'string' && raw.event !== '' ? raw.event : null;
  const unsupported: string[] = MATCHERS.filter((m) => isSet(raw[m]));
  if (isSet(raw.event) && typeof raw.event !== 'string') unsupported.unshift('event');
  const local = new NotCheckedList();
  const filters = filtersOf(raw.properties, local, 'properties');
  if (local.items.length > 0) unsupported.push('properties');
  return { event, filters, ...(unsupported.length > 0 ? { unsupported } : {}) };
}

/**
 * One `actions/{id}/` body as the action an action node carries, or undefined when the body is not
 * an action (no id, or steps that are not a list): the node then says the action was not read.
 */
export function normalizeAction(body: unknown): Action | undefined {
  if (!isRecord(body)) return undefined;
  const id = body.id;
  if (!(typeof id === 'number' && Number.isFinite(id)) && !(typeof id === 'string' && id !== ''))
    return undefined;
  if (!Array.isArray(body.steps)) return undefined;
  const name = typeof body.name === 'string' && body.name !== '' ? body.name : undefined;
  return { id, ...(name === undefined ? {} : { name }), steps: body.steps.map(step) };
}

/** A lookup over the `actions/{id}/` bodies that were read; ids compare as text (`7` is `"7"`). */
export function actionLookup(bodies: readonly unknown[]): ActionLookup {
  const byId = new Map<string, Action>();
  for (const body of bodies) {
    const action = normalizeAction(body);
    if (action !== undefined && !byId.has(String(action.id))) byId.set(String(action.id), action);
  }
  return (id) => byId.get(String(id));
}

function nodesOf(tile: Requirements['tiles'][number]): SeriesNode[] {
  return [
    ...(tile.series ?? []),
    ...(tile.exclusions ?? []),
    ...(tile.retention ? [tile.retention.target, tile.retention.returning] : []),
  ];
}

/**
 * The ids of every action the tiles name (series, funnel exclusions, retention entities), sorted
 * as text, so `pull` (T5.5) reads each `actions/{id}/` once and normalises again with the lookup.
 */
export function actionIdsOf(requirements: Pick<Requirements, 'tiles'>): (number | string)[] {
  const ids = new Map<string, number | string>();
  for (const tile of requirements.tiles)
    for (const node of nodesOf(tile))
      if (node.node === 'action' && !ids.has(String(node.action.id)))
        ids.set(String(node.action.id), node.action.id);
  return [...ids.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, id]) => id);
}
