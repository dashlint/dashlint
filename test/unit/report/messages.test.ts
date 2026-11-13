import { describe, expect, it } from 'vitest';
import type { AlertFinding } from '../../../src/check/alerts.js';
import type { CheckFinding } from '../../../src/check/checks/types.js';
import {
  alertMessage,
  andList,
  filterPhrase,
  findingMessage,
  formatPulledAt,
  orList,
  partName,
  reasonText,
  reportText,
} from '../../../src/report/messages.js';

const site = { file: 'web/src/shelf.ts', line: 4 };

function finding(extra: Partial<CheckFinding>): CheckFinding {
  return {
    check: 'property-is-sent',
    path: 'series[0].filters[0]',
    effect: 'dead',
    event: 'wishlist_shared',
    property: 'genre',
    values: ['Fiction'],
    code: 'no',
    sites: [site],
    detail: { role: 'filter', scope: 'event', op: 'exact', basis: 'high' },
    ...extra,
  };
}

const eventFinding = (extra: Partial<CheckFinding>): CheckFinding =>
  finding({
    check: 'event-has-call-site',
    event: 'gift_card_redeemed',
    path: 'series[0]',
    sites: [],
    detail: { basis: 'high' },
    ...extra,
  });

describe('event-has-call-site messages', () => {
  it('both say no', () => {
    expect(findingMessage(eventFinding({}), 'trends')).toBe(
      'queries `gift_card_redeemed`: no code sends it and PostHog has never seen it',
    );
  });

  it('code alone: no claim about PostHog', () => {
    const m = findingMessage(eventFinding({ detail: { basis: 'code-only' } }), 'trends');
    expect(m).toBe('queries `gift_card_redeemed`: no code sends it');
    expect(m).not.toContain('PostHog');
  });

  it('PostHog has no definition', () => {
    expect(findingMessage(eventFinding({ detail: { basis: 'not-defined' } }), 'trends')).toBe(
      'queries `gift_card_redeemed`: PostHog has no definition of it, so it has never arrived',
    );
  });

  it('names the closest event only when there is one', () => {
    const hinted = eventFinding({ hint: { closestEvent: 'giftcard_redeemed' } });
    expect(findingMessage(hinted, 'trends')).toMatch(
      /; closest event in code: `giftcard_redeemed`$/,
    );
    expect(findingMessage(eventFinding({}), 'trends')).not.toContain('closest');
  });

  it('a funnel step is named by its 1-based number', () => {
    const f = eventFinding({ path: 'series[2]' });
    expect(findingMessage(f, 'funnels')).toMatch(/^step 3 queries/);
    expect(findingMessage(f, 'trends')).toMatch(/^queries/);
  });

  it('produced elsewhere', () => {
    const f = eventFinding({ effect: 'info', detail: { producedElsewhere: true } });
    expect(findingMessage(f, 'trends')).toContain(
      'PostHog receives it: something else produces it',
    );
  });
});

describe('property-is-sent messages', () => {
  it('a positive filter, with what the code sends instead', () => {
    const f = finding({ hint: { closestProperty: 'genre_id' } });
    expect(findingMessage(f, 'trends')).toBe(
      'filters on `genre` = "Fiction", but no call site sends `genre` with `wishlist_shared` (they send `genre_id`), and PostHog has never seen `genre` on that event',
    );
    expect(findingMessage(finding({}), 'trends')).not.toContain('they send');
  });

  it('code alone and PostHog alone', () => {
    const code = finding({
      detail: { role: 'filter', scope: 'event', op: 'exact', basis: 'code-only' },
    });
    expect(findingMessage(code, 'trends')).not.toContain('PostHog');
    const seen = finding({
      detail: { role: 'filter', scope: 'event', op: 'exact', basis: 'observed' },
    });
    expect(findingMessage(seen, 'trends')).toBe(
      'filters on `genre` = "Fiction", but PostHog has never seen `genre` on `wishlist_shared`',
    );
  });

  it('a negative filter has no effect', () => {
    const f = finding({
      effect: 'degraded',
      values: ['none'],
      detail: { role: 'filter', scope: 'event', op: 'is_not', basis: 'code-only' },
    });
    expect(findingMessage(f, 'trends')).toBe(
      'filters out `genre` is not "none", but no call site sends `genre` with `wishlist_shared`, so the filter has no effect',
    );
  });

  it('a math property', () => {
    const f = finding({
      property: 'price',
      values: undefined,
      detail: { role: 'math-property', scope: 'event', basis: 'code-only' },
    });
    expect(findingMessage(f, 'trends')).toBe(
      'aggregates `price`, but no call site sends `price` with `wishlist_shared`',
    );
  });

  it('person properties', () => {
    const base = { role: 'filter' as const, scope: 'person' as const, op: 'exact' };
    expect(findingMessage(finding({ detail: { ...base, basis: 'high' } }), 'trends')).toBe(
      'filters on `genre` = "Fiction", but no code sets the person property `genre`, and PostHog has never seen it on a person',
    );
    expect(findingMessage(finding({ detail: { ...base, basis: 'observed' } }), 'trends')).toBe(
      'filters on `genre` = "Fiction", but PostHog has never seen the person property `genre`',
    );
    const hinted = finding({
      hint: { closestProperty: 'genres' },
      detail: { ...base, basis: 'code-only' },
    });
    expect(findingMessage(hinted, 'trends')).toContain('(it sets `genres`)');
  });

  it('a filter on any event', () => {
    const rest = finding({
      detail: { role: 'filter', scope: 'event', op: 'exact', basis: 'code-only' },
    });
    delete rest.event;
    expect(findingMessage(rest, 'trends')).toContain('with any event');
  });

  it('breakdowns: degraded and info', () => {
    const dead = finding({
      effect: 'degraded',
      property: 'format',
      event: undefined,
      detail: { role: 'breakdown', scope: 'event', missingOn: ['order_completed'] },
    });
    expect(findingMessage(dead, 'trends')).toBe(
      'breaks down by `format`, which no call site of `order_completed` sends: every row lands in one "(none)" bucket',
    );
    const some = finding({
      effect: 'info',
      property: 'format',
      detail: { role: 'breakdown', scope: 'event', missingOn: ['book_viewed', 'order_completed'] },
    });
    expect(findingMessage(some, 'trends')).toBe(
      'breaks down by `format`, which `book_viewed` or `order_completed` never sends: those rows land in one "(none)" bucket',
    );
    const sometimes = finding({
      effect: 'info',
      property: 'format',
      detail: { role: 'breakdown', scope: 'event', presence: 'sometimes' },
      event: undefined,
    });
    expect(findingMessage(sometimes, 'trends')).toContain('which only some call sites send');
  });
});

describe('value-is-reachable messages', () => {
  const value = (extra: Partial<CheckFinding>) =>
    finding({
      check: 'value-is-reachable',
      property: 'payment_method',
      code: 'yes',
      hint: { reachableValues: ['card', 'wallet'] },
      ...extra,
    });

  it('no value reachable', () => {
    const f = value({
      values: ['Voucher'],
      detail: { role: 'filter', scope: 'event', op: 'exact', unreachable: ['Voucher'] },
    });
    expect(findingMessage(f, 'funnels')).toBe(
      'step 1 filters `payment_method` = "Voucher", but the code can only send "card" or "wallet"',
    );
  });

  it('some values unreachable', () => {
    const f = value({
      effect: 'degraded',
      values: ['card', 'Voucher'],
      detail: { role: 'filter', scope: 'event', op: 'exact', unreachable: ['Voucher'] },
    });
    expect(findingMessage(f, 'trends')).toBe(
      'filters `payment_method` = "card" or "Voucher", but the code never sends "Voucher"; it can only send "card" or "wallet"',
    );
  });

  it('is_not on a value never sent', () => {
    const f = value({
      effect: 'degraded',
      values: ['Voucher'],
      detail: { role: 'filter', scope: 'event', op: 'is_not', unreachable: ['Voucher'] },
    });
    expect(findingMessage(f, 'trends')).toBe(
      'filters out `payment_method` = "Voucher", but the code never sends "Voucher", so that part of the filter has no effect',
    );
  });
});

describe('alert messages', () => {
  const alert = (detail: AlertFinding['detail']): AlertFinding => ({
    check: detail.result === 'invalid-target' ? 'alert-target-valid' : 'alert-can-never-fire',
    path: 'series[0]',
    code: 'no',
    sites: [],
    detail,
  });

  it('invalid targets name the count in the right noun', () => {
    expect(
      alertMessage(
        alert({
          result: 'invalid-target',
          target: { kind: 'formula', index: 1 },
          count: 1,
          of: 'formulas',
        }),
      ),
    ).toBe('watches formula 2, but the insight has 1 formula');
    expect(
      alertMessage(
        alert({
          result: 'invalid-target',
          target: { kind: 'funnel-step', index: 4 },
          count: 3,
          of: 'steps',
        }),
      ),
    ).toBe('watches step 5, but the insight has 3 steps');
    expect(
      alertMessage(
        alert({
          result: 'invalid-target',
          target: { kind: 'series', index: 2 },
          count: 2,
          of: 'series',
        }),
      ),
    ).toBe('watches series 3, but the insight has 2 series');
  });

  it('can never fire and fires on every check', () => {
    expect(
      alertMessage(
        alert({
          result: 'can-never-fire',
          target: { kind: 'series', index: 0 },
          condition: 'relative_increase',
        }),
      ),
    ).toBe(
      'can never fire: it watches series 1, which is always zero, under a `relative_increase` condition',
    );
    expect(
      alertMessage(
        alert({
          result: 'can-never-fire',
          target: { kind: 'series', index: 0 },
          watches: 'every-row',
        }),
      ),
    ).toBe('can never fire: it watches every breakdown row, which is always zero');
    expect(
      alertMessage(
        alert({
          result: 'fires-every-check',
          target: { kind: 'funnel-step', index: 0 },
          watches: 'funnel',
        }),
      ),
    ).toBe(
      'fires on every check: it watches the funnel, which is always zero, under a lower bound',
    );
  });
});

describe('helpers', () => {
  it('lists', () => {
    expect(orList([])).toBe('');
    expect(orList(['a'])).toBe('a');
    expect(orList(['a', 'b', 'c'])).toBe('a, b or c');
    expect(andList(['a', 'b'])).toBe('a and b');
  });

  it('filter phrases keep JSON types apart', () => {
    expect(filterPhrase('n', 'exact', [1, '1', true, null])).toBe('`n` = 1, "1", true or null');
    expect(filterPhrase('n', 'icontains', ['ab'])).toBe('`n` contains "ab"');
    expect(filterPhrase('n', 'not_icontains', ['ab'])).toBe('`n` does not contain "ab"');
    expect(filterPhrase('n', 'is_set', [])).toBe('`n` is set');
    expect(filterPhrase('n', 'is_not_set', [])).toBe('`n` is not set');
    expect(filterPhrase('n', 'gt', [3])).toBe('`n` gt 3');
    expect(filterPhrase('n', 'regex', [])).toBe('`n` regex');
    expect(filterPhrase('n', undefined, [])).toBe('`n`');
  });

  it('part names', () => {
    expect(partName('series[0].filters[1]', 'funnels')).toBe('step 1');
    expect(partName('series[0]', 'trends')).toBeUndefined();
    expect(partName('exclusions[0]', 'funnels')).toBe('the exclusion');
    expect(partName('retention.target', 'retention')).toBe('the target event');
    expect(partName('retention.returning', 'retention')).toBe('the returning event');
  });

  it('reasons: known codes in words, others as written', () => {
    expect(reasonText('open-event-name')).toContain('not literal');
    expect(reasonText('a SQL query')).toBe('a SQL query');
  });

  it('pull times', () => {
    expect(formatPulledAt('2026-12-18T09:12:00Z')).toBe('2026-12-18 09:12 UTC');
    expect(formatPulledAt('yesterday')).toBe('yesterday');
  });

  it('the catalog line rounds the rate down', () => {
    expect(reportText.catalog(3, 2, 1)).toBe(
      'Catalog: 3 call sites, 2 with literal event names (66%), 1 open',
    );
    expect(reportText.catalog(1, 1, 0)).toBe(
      'Catalog: 1 call site, 1 with literal event names (100%), 0 open',
    );
  });

  it('counts: live and not checked always, the rest when there are any', () => {
    const zero = {
      live: 0,
      dead: 0,
      partlyDead: 0,
      degraded: 0,
      onePlatform: 0,
      notChecked: 0,
      ignored: 0,
    };
    expect(reportText.counts(zero)).toBe('0 live · 0 not checked');
    expect(reportText.counts({ ...zero, dead: 1, ignored: 2 })).toBe(
      '0 live · 1 dead · 0 not checked · 2 ignored',
    );
  });

  it('header without a project or pull time', () => {
    expect(reportText.header('0.1.0', 'mixpanel')).toBe('dashlint 0.1.0 · Mixpanel');
  });

  it('alert lines show what PostHog shows', () => {
    expect(reportText.alertLine('A', 'm', null)).toBe('alert "A" m');
    expect(reportText.alertLine('A', 'm', 'Errored', false)).toBe(
      'alert "A" m (PostHog shows: disabled, Errored)',
    );
  });

  it('tile notes', () => {
    expect(reportText.deadSteps(3, 3)).toBe('step 3 is always zero');
    expect(reportText.deadSteps(2, 4)).toBe('steps 2 to 4 are always zero');
    expect(reportText.alertNote('A', 'can-never-fire')).toBe('alert "A" can never fire');
    expect(reportText.partsNotChecked(1)).toBe('1 part not checked');
    expect(reportText.kindNotChecked('trends')).toBeUndefined();
  });
});
