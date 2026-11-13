// Members destructured from the hook's client, renamed or not.
import { usePostHog } from 'posthog-js/react';

export function useCart(): void {
  const { capture } = usePostHog();
  const { capture: track } = usePostHog();
  capture('cart_viewed');
  track('cart_emptied');
  usePostHog().capture('cart_shared');
}
