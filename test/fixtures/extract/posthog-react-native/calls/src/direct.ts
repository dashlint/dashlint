// Direct calls on a client: capture is inherited from PostHogCore, screen is the subclass's own.
import PostHog from 'posthog-react-native';

export const posthog = new PostHog('demo-token');

export function openShelf(shelfId: string): void {
  posthog.capture('shelf_opened', { shelf_id: shelfId });
  posthog.screen('Shelf', { shelf_id: shelfId });
}

export function signIn(readerId: string): void {
  posthog.identify(readerId, { $set: { plan: 'monthly' } });
  posthog.register({ storefront: 'app' });
  posthog.setPersonProperties({ favourite_genre: 'poetry' });
  posthog.reset();
}
