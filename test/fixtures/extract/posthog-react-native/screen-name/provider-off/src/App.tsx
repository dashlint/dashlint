// captureScreens is false (through a const alias) and nothing calls screen(): no event carries
// $screen_name (ADR-047). A second provider, given a client, has autocapture false.
import PostHog, { PostHogProvider, usePostHog } from 'posthog-react-native';

const autocapture = { captureScreens: false, captureTouches: true } as const;

export function App() {
  return (
    <PostHogProvider apiKey="demo-token" autocapture={autocapture}>
      {null}
    </PostHogProvider>
  );
}

const shared = new PostHog('demo-token');

export function Embedded() {
  return (
    <PostHogProvider client={shared} autocapture={false}>
      {null}
    </PostHogProvider>
  );
}

export function useWishlist(): () => void {
  const posthog = usePostHog();
  return () => posthog.capture('wishlist_added', { title: 'atlas' });
}
