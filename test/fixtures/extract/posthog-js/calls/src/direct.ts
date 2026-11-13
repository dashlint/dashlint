// Direct calls on the default export.
import posthog from 'posthog-js';

export function shelveBook(isbn: string): void {
  posthog.capture('book_shelved', { isbn });
}

export function signIn(readerId: string): void {
  posthog.identify(readerId, { plan: 'monthly' });
  posthog.register({ storefront: 'web' });
  posthog.register_once({ first_genre: 'poetry' });
  posthog.setPersonProperties({ favourite_genre: 'poetry' });
  posthog.people.set({ newsletter: true });
  posthog.people.set_once({ joined_via: 'web' });
}

export function signOut(): void {
  posthog
    // the site's line is the line of the called name
    .reset();
  posthog.init('demo-token');
}
