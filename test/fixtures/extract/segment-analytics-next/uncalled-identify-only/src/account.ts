// The source loads @segment/analytics-next and identifies the reader, but no event call site of
// the package is found: an event it does not send stays unknown (ADR-069).
import { AnalyticsBrowser } from '@segment/analytics-next';

const analytics = AnalyticsBrowser.load({ writeKey: 'bookshop-demo' });

export function signIn(readerId: string): void {
  void analytics.identify(readerId);
}

export function signOut(): void {
  void analytics.reset();
}
