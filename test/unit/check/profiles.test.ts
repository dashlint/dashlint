import { describe, expect, it } from 'vitest';
import {
  NEGATIVE_OPERATORS,
  POSITIVE_OPERATORS,
  SEMVER_NEQ,
  genericProfile,
  posthogProfile,
  profileFor,
} from '../../../src/check/index.js';
import type { Scope } from '../../../src/formats/requirements.js';

// Spec 6.6, listed exactly.
const POSITIVE = [
  'exact',
  'icontains',
  'regex',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_set',
  'is_date_exact',
  'is_date_before',
  'is_date_after',
  'semver_eq',
  'semver_gt',
  'semver_gte',
  'semver_lt',
  'semver_lte',
  'semver_tilde',
  'semver_caret',
  'semver_wildcard',
];
const NEGATIVE = ['is_not', 'not_icontains', 'not_regex', 'is_not_set', 'not_in'];
// PostHog operators the table does not list: unknown in both profiles.
const UNLISTED = [
  'starts_with',
  'not_starts_with',
  'ends_with',
  'not_ends_with',
  'between',
  'not_between',
  'min',
  'max',
  'in',
  'is_cleaned_path_exact',
  'is_cleaned_path_not_exact',
  'flag_evaluates_to',
  'icontains_multi',
  'not_icontains_multi',
  'Exact',
  '',
  '__proto__',
];

describe('the operator lists are the table, exactly', () => {
  it('positive and negative sets', () => {
    expect([...POSITIVE_OPERATORS].sort()).toEqual([...POSITIVE].sort());
    expect([...NEGATIVE_OPERATORS].sort()).toEqual([...NEGATIVE].sort());
    expect(SEMVER_NEQ).toBe('semver_neq');
  });
});

describe('row 1: positive operator on a never-sent property', () => {
  it.each(POSITIVE)('%s: no match (part dead) in both profiles', (op) => {
    expect(posthogProfile.neverSent(op)).toBe('no-match');
    expect(genericProfile.neverSent(op)).toBe('no-match');
  });
});

describe('row 2: negative operator on a never-sent property', () => {
  it.each(NEGATIVE)('%s: no effect (degraded) in posthog, unknown in generic', (op) => {
    expect(posthogProfile.neverSent(op)).toBe('no-effect');
    expect(genericProfile.neverSent(op)).toBe('unknown');
  });
});

describe('row 3: semver_neq on a never-sent property', () => {
  it('drops the event in posthog, unknown in generic', () => {
    expect(posthogProfile.neverSent('semver_neq')).toBe('no-match');
    expect(genericProfile.neverSent('semver_neq')).toBe('unknown');
  });
});

describe('operators the table does not list', () => {
  it.each(UNLISTED)('%j: unknown in both profiles, never compared by value', (op) => {
    expect(posthogProfile.neverSent(op)).toBe('unknown');
    expect(genericProfile.neverSent(op)).toBe('unknown');
    expect(posthogProfile.valueRule(op)).toBe('not-checked');
    expect(genericProfile.valueRule(op)).toBe('not-checked');
  });
});

describe('row 4: exact and is_not against a finite domain', () => {
  it('both compare by equality', () => {
    for (const p of [posthogProfile, genericProfile]) {
      expect(p.valueRule('exact')).toBe('equal');
      expect(p.valueRule('is_not')).toBe('equal');
    }
  });

  it('posthog: same-type values decide', () => {
    expect(posthogProfile.equal('card', 'card')).toBe('yes');
    expect(posthogProfile.equal('card', 'paypal')).toBe('no');
    expect(posthogProfile.equal(3, 3)).toBe('yes');
    expect(posthogProfile.equal(3, 4)).toBe('no');
    expect(posthogProfile.equal(true, true)).toBe('yes');
    expect(posthogProfile.equal(true, false)).toBe('no');
  });

  it('posthog: exact is case-sensitive for text (V3 R4, reproduced in the demo)', () => {
    expect(posthogProfile.equal('Card', 'card')).toBe('no');
    expect(posthogProfile.equal('card', 'CARD')).toBe('no');
    expect(posthogProfile.equal('Cash', 'Cash')).toBe('yes');
  });

  it('posthog: a case-only difference in true or false stays unknown (V3 R3 not reproduced)', () => {
    expect(posthogProfile.equal('true', 'True')).toBe('unknown');
    expect(posthogProfile.equal('FALSE', 'false')).toBe('unknown');
  });

  it('posthog: string-number-boolean coercion and null stay unknown', () => {
    expect(posthogProfile.equal('true', true)).toBe('unknown');
    expect(posthogProfile.equal('false', true)).toBe('unknown');
    expect(posthogProfile.equal('0', 0)).toBe('unknown');
    expect(posthogProfile.equal(1, '2')).toBe('unknown');
    expect(posthogProfile.equal(true, 'yes')).toBe('unknown');
    expect(posthogProfile.equal(null, null)).toBe('unknown');
    expect(posthogProfile.equal('card', null)).toBe('unknown');
  });

  it('generic: unknown unless both sides are strings', () => {
    expect(genericProfile.equal('card', 'card')).toBe('yes');
    expect(genericProfile.equal('card', 'paypal')).toBe('no');
    expect(genericProfile.equal('Card', 'card')).toBe('unknown');
    expect(genericProfile.equal(3, 4)).toBe('unknown');
    expect(genericProfile.equal(3, 3)).toBe('unknown');
    expect(genericProfile.equal(true, false)).toBe('unknown');
    expect(genericProfile.equal('true', true)).toBe('unknown');
    expect(genericProfile.equal(null, null)).toBe('unknown');
  });
});

describe('row 5: icontains against a finite domain', () => {
  it.each([posthogProfile, genericProfile])('$name: case-insensitive substring', (p) => {
    expect(p.valueRule('icontains')).toBe('contains');
    expect(p.contains('card', 'gift card')).toBe('yes');
    expect(p.contains('CARD', 'Gift Card')).toBe('yes');
    expect(p.contains('', 'paypal')).toBe('yes');
    expect(p.contains('card', 'paypal')).toBe('no');
    expect(p.contains('paperback', 'paper')).toBe('no');
  });

  it.each([posthogProfile, genericProfile])(
    '$name: non-strings and non-ASCII case folds are unknown',
    (p) => {
      expect(p.contains('1', 1)).toBe('unknown');
      expect(p.contains(true, 'true')).toBe('unknown');
      expect(p.contains(null, 'x')).toBe('unknown');
      expect(p.contains('Ä', 'ä')).toBe('unknown');
      expect(p.contains('é', 'café')).toBe('yes');
      expect(p.contains('x', 'café')).toBe('unknown');
    },
  );
});

describe('row 6: regex and not_regex values', () => {
  it('are not checked in either profile', () => {
    for (const p of [posthogProfile, genericProfile]) {
      expect(p.valueRule('regex')).toBe('not-checked');
      expect(p.valueRule('not_regex')).toBe('not-checked');
      expect(p.valueRule('not_icontains')).toBe('not-checked');
    }
  });
});

describe('row 7 and 8: scopes', () => {
  const unchecked: Scope[] = ['session', 'cohort', 'element', 'feature', 'hogql', 'group', 'other'];
  it.each(unchecked)('%s is not checked in either profile', (scope) => {
    expect(posthogProfile.checksScope(scope)).toBe(false);
    expect(genericProfile.checksScope(scope)).toBe(false);
  });
  it('event and person are checked; only posthog needs observed person properties', () => {
    for (const p of [posthogProfile, genericProfile]) {
      expect(p.checksScope('event')).toBe(true);
      expect(p.checksScope('person')).toBe(true);
    }
    expect(posthogProfile.personNeedsObserved).toBe(true);
    expect(genericProfile.personNeedsObserved).toBe(false);
  });
});

describe('profileFor', () => {
  it('posthog for PostHog files, generic for anything else', () => {
    expect(profileFor({ platform: 'posthog' })).toBe(posthogProfile);
    expect(profileFor({ platform: 'posthog', profile: 'posthog' })).toBe(posthogProfile);
    expect(profileFor({ platform: 'mixpanel' })).toBe(genericProfile);
    expect(profileFor({ platform: 'amplitude' })).toBe(genericProfile);
  });
  it('source.profile can only make it more cautious', () => {
    expect(profileFor({ platform: 'posthog', profile: 'generic' })).toBe(genericProfile);
    expect(profileFor({ platform: 'mixpanel', profile: 'posthog' })).toBe(genericProfile);
    expect(profileFor({ platform: 'PostHog' })).toBe(genericProfile);
  });
});
