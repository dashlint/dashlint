// A pull request on the invented bookshop (spec 6.17) for the PR comment goldens: `checkout_started`
// renamed to `checkout_begun` in both apps, and `payment_method` dropped from `payment_submitted`.
import { diffResults, type DiffResult, type Enclosing } from '../../../src/check/index.js';
import type { Catalog } from '../../../src/formats/catalog.js';
import type { Requirements } from '../../../src/formats/requirements.js';
import { validateRequirements } from '../../../src/formats/validate.js';
import type { CommentInput, ReportModel } from '../../../src/report/index.js';
import { bookshop, catalogs, context, IGNORE, NOW, requirements } from './bookshop.js';

/** Every site sits in one function per file, so a name changed in place reads as a rename. */
const enclosing: Enclosing = (file) => `${file}#handler`;

/**
 * The snapshot without observed data: with it, PostHog still sees `checkout_started` arriving from
 * the deployed apps, so the rename reads as live until the old name stops (spec 6.7.1).
 */
export function diffRequirements(): Requirements {
  const r = requirements(false);
  r.tiles.push({
    id: 'insight:Pm11',
    title: 'Payments by method',
    url: 'https://us.posthog.com/project/12345/insights/Pm11',
    dashboards: ['dashboard:41'],
    kind: 'trends',
    series: [{ node: 'event', event: 'payment_submitted', ref: 'A' }],
    breakdown: [{ key: 'payment_method', scope: 'event' }],
  });
  r.alerts.push({
    id: 'alert:3a4b',
    name: 'Checkouts dropped',
    tile: 'insight:Ca10',
    target: { kind: 'series', index: 0 },
    condition: 'absolute_value',
    bounds: { lower: false, upper: true },
    state: 'Not firing',
  });
  const v = validateRequirements(r);
  if (!v.ok) throw new Error(`invalid bookshop diff requirements: ${JSON.stringify(v.errors)}`);
  return r;
}

/**
 * The bookshop's catalogs with every event name literal: a non-literal name could be any event, so
 * code alone could not call a renamed one dead (spec 6.7.1).
 */
export function baseCatalogs(): Catalog[] {
  return catalogs().map((c) => ({
    ...c,
    coverage: {
      ...c.coverage,
      literalNameSites: c.coverage.callSites,
      openSites: 0,
      nameResolutionRate: 1,
    },
  }));
}

/** The head of the pull request: the rename and the dropped property in both sources. */
export function headCatalogs(): Catalog[] {
  return baseCatalogs().map((c) => {
    const events = { ...c.events };
    const started = events['checkout_started'];
    if (started !== undefined) {
      delete events['checkout_started'];
      events['checkout_begun'] = started;
    }
    const paid = events['payment_submitted'];
    if (paid !== undefined) events['payment_submitted'] = { ...paid, properties: {} };
    return { ...c, events };
  });
}

function comment(base: Catalog[], head: Catalog[]): CommentInput {
  const req = diffRequirements();
  const diff: DiffResult = diffResults({
    requirements: req,
    baseRequirements: req,
    base: { catalogs: base, commit: '5f0c2e1', enclosing },
    head: { catalogs: head, commit: '9d3a7b0', enclosing },
    contextFor: context,
    failOn: 'dead',
    ignore: IGNORE,
    now: NOW,
  });
  const model: ReportModel = bookshop({ catalogs: head, requirements: req, mode: 'diff' });
  return { diff, head: model, requirementsFile: 'dashlint.requirements.json' };
}

/** The pull request that breaks tiles and an alert. */
export const renamePr = (): CommentInput => comment(baseCatalogs(), headCatalogs());

/** A pull request that changes no analytics call. */
export const noopPr = (): CommentInput => comment(baseCatalogs(), baseCatalogs());
