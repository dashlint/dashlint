// package.json names @segment/analytics-next and the source calls it: an event no site sends is
// "not sent" as before (ADR-069).
import { AnalyticsBrowser } from '@segment/analytics-next';

const analytics = AnalyticsBrowser.load({ writeKey: 'bookshop-demo' });

export function addToBasket(isbn: string): void {
  void analytics.track('Basket Added', { isbn });
}
