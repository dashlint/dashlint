// The bookshop's web client: init(apiKey, userId, options) with element clicks on, page views off
// and the IP address left out; the reader's plan and first year through an Identify object.
import { Identify, identify, init, reset, setUserId } from '@amplitude/analytics-browser';

init('bookshop-key', undefined, {
  autocapture: { elementInteractions: true, pageViews: false },
  trackingOptions: { ipAddress: false },
});

export function signIn(readerId: string): void {
  setUserId(readerId);
  const reader = new Identify();
  reader.set('plan', 'member');
  reader.setOnce('joined_year', 2026);
  identify(reader);
}

export function signOut(): void {
  reset();
}
