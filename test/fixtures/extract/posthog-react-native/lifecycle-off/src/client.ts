// Lifecycle events switched off: the SDK does not send them.
import PostHog from 'posthog-react-native';

export const posthog = new PostHog('demo-token', {
  host: 'https://analytics.example.test',
  captureAppLifecycleEvents: false,
});

export function openShelf(): void {
  posthog.capture('shelf_opened');
}
