// posthog-react-native with no init here: its $identify is undecided, but posthog-js sends it.
import { usePostHog } from 'posthog-react-native';

export function useShelf(): () => void {
  const posthog = usePostHog();
  return () => posthog.capture('shelf_opened');
}
