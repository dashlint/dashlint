// Open properties: an index signature, `any`, `unknown`, a type parameter, `{}`, a computed key
// of type `string` or a spread of any of these. Properties written beside them are still listed.
import posthog from 'posthog-js';

declare const extra: Record<string, unknown>;
declare const text: string;
const loose = JSON.parse(text);
declare const opaque: object;
declare const empty: NonNullable<unknown>;
declare const dynamicKey: string;

export function open(): void {
  posthog.capture('cart_viewed', { ...extra, items: 2 });
  posthog.capture('cart_emptied', loose);
  posthog.capture('cart_shared', opaque);
  posthog.capture('cart_named', empty);
  posthog.capture('cart_tagged', { [dynamicKey]: 1, items: 3 });
  posthog.capture('cart_checked', extra);
}

export function sendTyped<T extends object>(props: T): void {
  posthog.capture('cart_saved', props);
}

// The same event as a closed site in values.ts would be: one open site keeps "no" facts unknown.
export function viewedClosed(): void {
  posthog.capture('cart_viewed', { items: 1, gift: false });
}

// A control event sent only from closed sites.
export function restocked(): void {
  posthog.capture('cart_restocked', { items: 4 });
}

// A wrapper that accepts anything as properties: each call's argument decides.
export function trackLoose(event: string, props: unknown): void {
  posthog.capture(event, props as Record<string, unknown>);
}

declare const rest: [Record<string, string>];

export function notObjects(): void {
  trackLoose('cart_counted', 42);
  trackLoose('cart_listed', ['gift']);
  trackLoose('cart_kept', { items: 5 });
  posthog.capture('cart_split', ...rest);
}

// Known keys beside a type parameter are listed; the site is still open.
export function sendMixed<T extends object>(props: T & { items: number }): void {
  posthog.capture('cart_mixed', props);
}

// Properties read from a key of an `any` argument have type `any`.
export function trackPair(event: string, input: { props: { items: number } }): void {
  posthog.capture(event, input.props);
}

export function fromAny(): void {
  trackPair('cart_loaded', loose);
}
