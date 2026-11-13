// Lifecycle events switched on explicitly.
import PostHog from 'posthog-react-native';

export const posthog = new PostHog('demo-token', { captureAppLifecycleEvents: true });

export function openShelf(): void {
  posthog.capture('shelf_opened');
}
