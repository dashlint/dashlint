// Presence: optional properties, values that may be undefined and conditional spreads are sent
// sometimes; everything else always.
import posthog from 'posthog-js';

interface ReviewProps {
  title: string;
  rating?: number;
  draft: boolean | undefined;
}
declare const review: ReviewProps;
declare const note: string | undefined;
declare const signedIn: boolean;
declare const coupon: string;
declare const web: { source: 'web' };
declare const maybeWeb: { source: 'web' } | undefined;
declare const key: 'genre' | 'author';
declare const quiet: { muted: true } | null;

export function presence(): void {
  posthog.capture('review_saved', review);
  posthog.capture('review_noted', { note, gone: undefined });
  posthog.capture('basket_viewed', {
    items: 2,
    ...(signedIn ? { reader: 'member' } : {}),
    ...(signedIn && { loyalty: true }),
    ...(coupon && { coupon }),
  });
  posthog.capture(
    'basket_paid',
    signedIn ? { method: 'card' } : { method: 'voucher', voucher: 'gift' },
  );
  posthog.capture('basket_left', quiet);
}

export function overrides(): void {
  // A later key replaces an earlier one; one sent sometimes leaves the earlier value possible.
  posthog.capture('shop_entered', { source: 'app', ...web });
  posthog.capture('shop_left', { source: 'app', ...maybeWeb });
  posthog.capture('shop_browsed', { [key]: 'poetry', ['fixed']: 1 });
}

export function nothing(): void {
  posthog.capture('shop_closed');
  posthog.capture('shop_paused', null);
  posthog.capture('shop_reset', {});
}

declare const wrapping: '' | 0 | false | { wrapping: 'gift' };
declare const pages: number;

export function falsy(): void {
  // `''`, `0` and `false` spread nothing; `pages && ...` may be 0; `web && ...` always holds.
  posthog.capture('shop_wrapped', {
    ...wrapping,
    ...(pages && { long: true }),
    ...(web && { online: true }),
  });
}

declare const cleared: { source: undefined };
declare const maybeSource: { source: 'web' | undefined };

export function unset(): void {
  // A later key written as `undefined` is not sent, so the earlier value is gone.
  posthog.capture('shop_cleared', { source: 'app', ...cleared });
  posthog.capture('shop_unset', { source: 'app', ...maybeSource });
  posthog.capture('shop_unsure', { source: 'app', ...(signedIn && maybeSource) });
}

export function members(): void {
  // A method is a function value; a getter's value is whatever it returns.
  posthog.capture('shop_counted', {
    count() {
      return 1;
    },
    get size() {
      return 2;
    },
  });
}
