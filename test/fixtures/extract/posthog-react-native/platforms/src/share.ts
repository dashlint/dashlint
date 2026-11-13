import PostHog from 'posthog-react-native';

export const posthog = new PostHog('demo-token');

export function share(): void {
  posthog.capture('wishlist_shared');
}
