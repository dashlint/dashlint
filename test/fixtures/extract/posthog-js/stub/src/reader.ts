import { usePostHog } from 'posthog-js/react';

export function usePreview(): void {
  const client = usePostHog();
  client.capture('book_previewed');
}
