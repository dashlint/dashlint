// Spec T4.4 negative control: hooks named useAnalytics that are not Segment's, the app's own and
// one from another package whose ClientMethods type has Segment's member names.
import { useAnalytics as useMetrics } from '@bookshop/metrics';

function useAnalytics(): { track: (name: string, props?: Record<string, string>) => string } {
  return { track: (name) => name };
}

export function own(): void {
  useAnalytics().track('Local Only', { shelf: 'a' });
}

export function foreign(): void {
  const { track, identify } = useMetrics();
  track('Metrics Only', { shelf: 'b' });
  identify('reader-9', { loyalty_tier: 'gold' });
}
