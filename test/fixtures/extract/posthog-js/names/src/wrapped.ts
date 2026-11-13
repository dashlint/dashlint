// Names that reach the SDK through the shop's wrappers: each call of a wrapper decides its own.
import posthog from 'posthog-js';
import { pick, type ShelfEvent } from './events';

// The parameter allows two names.
export function trackShelf(name: ShelfEvent): void {
  posthog.capture(name);
}

// A default name when the call leaves it out.
export function trackView(name: 'page_viewed' | 'page_left' = 'page_viewed'): void {
  posthog.capture(name);
}

// The name inside an object parameter.
export function send(e: { name: 'cart_viewed' | 'cart_emptied' }): void {
  posthog.capture(e.name);
}

// An optional name: a call may leave it out.
export function trackMaybe(name?: 'wishlist_saved'): void {
  if (name) posthog.capture(name);
}

const either = pick<ShelfEvent>();
const cart = pick<{ name: 'cart_viewed' | 'cart_emptied' }>();
const args = ['book_lent'] as const;

export function sendWrapped(): void {
  trackShelf('shelf_opened');
  trackShelf(either);
  trackView();
  trackView('page_left');
  send({ name: 'cart_viewed' });
  send(cart);
  trackMaybe('wishlist_saved');
  trackMaybe();
  posthog.capture(...args);
}

// Any string: a template given to it has type `string`, so it is expanded from its parts.
export function trackAny(name: string): void {
  posthog.capture(name);
}

export function sendAny(): void {
  trackAny(`floor_${pick<1 | 2>()}`);
  trackAny(`gift_${pick<boolean>()}`);
  trackAny(`stock_${pick<number>()}`);
}
