// Open event names that still have a fixed head or tail, one call per line (ADR-061).
import posthog from 'posthog-js';

declare function pick<T>(): T;

const channel = pick<string>();
const count = pick<number>();

// Any string: a template given to it is open, but keeps its head and tail.
export function trackDynamic(name: string): void {
  posthog.capture(name);
}

export function share(): void {
  posthog.capture(`shared_via_${channel}`);
  posthog.capture(`${channel}_coupon_redeemed`);
  posthog.capture(`gift_${channel}_${count}_wrapped`);
  posthog.capture(`${channel}`);
  posthog.capture(`${channel}${count}`);
  posthog.capture(pick<`review_${string}_posted`>());
  posthog.capture(pick<`${string}`>());
  posthog.capture(channel);
  trackDynamic(`lent_to_${channel}`);
  posthog.capture('book_shared');
}
