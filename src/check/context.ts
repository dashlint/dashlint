// The check context from catalogs and requirements (spec 6.4 item 11, 6.6): the catalogs merged
// with the descriptors' builtin tables, the code facts and the index the checks read.
import {
  eventFact,
  mergeCatalogs,
  personPropertyFact,
  propertyFact,
  type BuiltinTables,
} from '../extract/merge.js';
import type { Catalog } from '../formats/catalog.js';
import type { Requirements } from '../formats/requirements.js';
import type { CheckContext, CodeIndex } from './checks/types.js';
import type { CodeFacts } from './facts.js';
import { profileFor } from './profiles/index.js';

export function checkContext(
  catalogs: readonly Catalog[],
  requirements: Requirements,
  tables: BuiltinTables,
): CheckContext {
  const m = mergeCatalogs(catalogs, tables);
  const code: CodeFacts = {
    event: (n) => eventFact(m, n),
    property: (e, k) => propertyFact(m, e, k),
    personProperty: (k) => personPropertyFact(m, k),
    nameResolutionRates: m.sources.map((s) => s.catalog.coverage.nameResolutionRate),
  };
  const merged = (e: string) => (Object.hasOwn(m.events, e) ? m.events[e] : undefined);
  const index: CodeIndex = {
    events: Object.keys(m.events),
    propertyKeys: (e) => Object.keys(merged(e)?.properties ?? {}),
    personPropertyKeys: Object.keys(m.personProperties),
    // Catalog sites are repository-relative already (spec 6.3.1), the source's folder included.
    sites: (e) => (merged(e)?.sites ?? []).map((s) => ({ file: s.file, line: s.line })),
    platforms: m.platforms,
    eventPlatforms: (e) => merged(e)?.platforms ?? [],
  };
  return {
    facts: {
      code,
      ...(requirements.observed === undefined ? {} : { observed: requirements.observed }),
      ...(requirements.source.pulledAt === undefined
        ? {}
        : { pulledAt: requirements.source.pulledAt }),
    },
    index,
    profile: profileFor(requirements.source),
  };
}
