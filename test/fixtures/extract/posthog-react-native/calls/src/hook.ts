// Members destructured from the hook's client.
import { usePostHog } from 'posthog-react-native';

export function useReadingList(): void {
  const { capture, screen } = usePostHog();
  capture('reading_list_viewed');
  screen('ReadingList');
}
