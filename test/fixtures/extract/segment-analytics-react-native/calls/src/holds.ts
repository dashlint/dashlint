// useAnalytics() destructured and kept whole, the client itself, and a screen call (no site).
import { useAnalytics } from '@segment/analytics-react-native';
import { segment } from './client';

export function useHold(): (format: 'audiobook' | 'paperback') => void {
  const { track, identify, reset } = useAnalytics();
  return (format) => {
    void track('Hold Placed', { format });
    void identify('reader-3', { reading_goal: 12 });
    void reset();
  };
}

export function useRating(): () => void {
  const analytics = useAnalytics();
  return () => void analytics.track('Review Rated', { stars: 4 });
}

export function visit(): void {
  void segment.track('Branch Visited', { branch: 'north' });
  void segment.screen('Catalog');
}
