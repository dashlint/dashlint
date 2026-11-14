import mixpanel from 'mixpanel-browser';
import * as analytics from 'mixpanel-browser';

analytics.init('bookshop-token', { track_marketing: false });

export function shelve(): void {
  mixpanel.track('book_shelved', { shelf: 'fiction' });
  analytics.track('book_previewed');
  analytics.people.set('newsletter', true);
}
