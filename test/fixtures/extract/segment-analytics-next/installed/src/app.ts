// The installed package's own types: AnalyticsBrowser's arrow-typed track, and the loaded
// Analytics class whose members take rest tuples.
import { AnalyticsBrowser, type Analytics } from '@segment/analytics-next';

const analytics = AnalyticsBrowser.load({ writeKey: 'bookshop-demo' });

export function reserve(): void {
  void analytics.track('Book Reserved', { format: 'ebook' });
}

export async function later(loaded: Analytics): Promise<void> {
  await loaded.track({ type: 'track', event: 'Shelf Browsed', properties: { aisle: 7 } });
  await loaded.identify({ favourite_genre: 'drama' });
}
