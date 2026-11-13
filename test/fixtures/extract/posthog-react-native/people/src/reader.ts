// identify with $set, with $set_once only (the rest of the object is set), and register.
import PostHog from 'posthog-react-native';

export const posthog = new PostHog('demo-token');

export function signIn(readerId: string, email: string): void {
  posthog.identify(readerId, { $set: { plan: 'monthly' }, $set_once: { first_shelf: 'poetry' } });
  posthog.identify(readerId, { email, $set_once: { joined_via: 'app' } });
  posthog.identify(readerId, { $set: { plan: 'yearly' } });
  posthog.register({ storefront: 'app' });
}
