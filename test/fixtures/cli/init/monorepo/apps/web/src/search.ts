import posthog from 'posthog-js';

export function searched(query: string): void {
  posthog.capture('shelf_searched', { query });
}
