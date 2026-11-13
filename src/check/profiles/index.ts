import type { Requirements } from '../../formats/requirements.js';
import { genericProfile } from './generic.js';
import { posthogProfile } from './posthog.js';
import type { RulesProfile } from './types.js';

export { NEGATIVE_OPERATORS, POSITIVE_OPERATORS, SEMVER_NEQ } from './common.js';
export { genericProfile } from './generic.js';
export { posthogProfile } from './posthog.js';
export type * from './types.js';

/**
 * The profile for a requirements file (spec 6.6): `posthog` when `source.platform` is `posthog`,
 * `generic` otherwise. `source.profile` can only make it more cautious: `generic` on a PostHog
 * file is honoured, `posthog` on another platform is not (ADR-037).
 */
export function profileFor(
  source: Pick<Requirements['source'], 'platform' | 'profile'>,
): RulesProfile {
  return source.platform === 'posthog' && source.profile !== 'generic'
    ? posthogProfile
    : genericProfile;
}
