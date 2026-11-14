// Track in its name and event object forms, the link and form helpers, identify with an id or
// with the traits alone, a wrapper, and page calls (no site of their own).
import type { Analytics, AnalyticsCore } from '@segment/analytics-next';
import { analytics } from './boot';

export function reserve(format: 'hardcover' | 'ebook'): void {
  void analytics.track('Book Reserved', { format, pickup: true });
}

export function applyCoupon(): void {
  // The second argument of the object form is the options, never properties.
  void analytics.track(
    { type: 'track', event: 'Coupon Applied', properties: { tier: 'gold' } },
    { context: { locale: 'en' } },
  );
}

export async function browse(loaded: Analytics, core: AnalyticsCore): Promise<void> {
  await loaded.track('Shelf Browsed', { aisle: 3 });
  await core.track('Store Hours Viewed');
}

export function wire(card: Element, form: HTMLFormElement): void {
  void analytics.trackLink(card, 'Author Page Opened', { from: 'card' });
  void analytics.trackSubmit(form, 'Newsletter Joined');
  // A name computed per element at runtime: open world.
  void analytics.trackClick(card, (el: Element) => el.id);
}

export function who(): void {
  void analytics.identify('reader-1', { plan: 'member' });
  void analytics.identify({ favourite_genre: 'poetry' });
  void analytics.identify('reader-2');
  void analytics.reset();
}

function sendShop(event: 'Gift Wrapped' | 'Gift Card Sent', ribbon: 'red' | 'gold'): void {
  void analytics.track(event, { ribbon });
}

export function gift(): void {
  sendShop('Gift Wrapped', 'red');
}

export function pages(): void {
  void analytics.page('Catalog');
  void analytics.page('Shop', 'Checkout', { step: 2 });
}
