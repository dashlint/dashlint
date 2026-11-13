// A hook that returns an object of wrappers.
import { usePostHog } from 'posthog-js/react';

// Stands in for useCallback: returns the function it is given.
function memo<T>(fn: T): T {
  return fn;
}

export function useShelfAnalytics() {
  const posthog = usePostHog();
  const track = memo((event: string, props?: { isbn: string }) => posthog.capture(event, props));
  return {
    track,
    // Not a wrapper: the event name is fixed.
    trackList: (list: string) => posthog.capture('list_viewed', { list }),
    trackGenre(event: string) {
      posthog.capture(event, { genre: 'poetry' });
    },
  };
}
