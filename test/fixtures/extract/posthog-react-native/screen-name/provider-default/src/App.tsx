// A provider with the default autocapture calls screen() on navigation when the app's navigation
// is wired to it, which code cannot tell: $screen_name is unknown on other events (ADR-047).
import { PostHogProvider, usePostHog } from 'posthog-react-native';

export function App() {
  return <PostHogProvider apiKey="demo-token">{null}</PostHogProvider>;
}

export function useCart(): () => void {
  const posthog = usePostHog();
  return () => posthog.capture('cart_viewed', { items: 2 });
}
