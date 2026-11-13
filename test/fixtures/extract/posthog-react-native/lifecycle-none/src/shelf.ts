// No init in this source: the client comes from elsewhere, so options are unknown.
import { usePostHog } from 'posthog-react-native';

export function useShelf(): () => void {
  const posthog = usePostHog();
  return () => posthog.capture('shelf_opened');
}
