// A screen() call registers $screen_name for the session, so later events may carry it (ADR-047).
// The provider turns its own screen capture off; the screen() call alone sends the property.
import { PostHogProvider, usePostHog } from 'posthog-react-native';

export function App() {
  return (
    <PostHogProvider apiKey="demo-token" autocapture={{ captureScreens: false }}>
      {null}
    </PostHogProvider>
  );
}

export function useShelfRoute(pathname: string): () => void {
  const posthog = usePostHog();
  void posthog.screen(pathname);
  return () => posthog.capture('book_previewed', { format: 'paperback' });
}
