// The bookshop's web client: init with autocapture on and marketing parameters off.
import mixpanel from 'mixpanel-browser';

mixpanel.init('bookshop-token', { autocapture: { scroll: false }, track_marketing: false });
mixpanel.register({ store: 'harbour street' });
mixpanel.register_once({ first_visit: true });

export function signIn(readerId: string): void {
  mixpanel.identify(readerId);
  mixpanel.people.set({ plan: 'member' });
  mixpanel.people.set('favourite_genre', 'poetry');
  mixpanel.people.set_once({ joined_year: 2026 });
}

export function signOut(): void {
  mixpanel.reset();
}
