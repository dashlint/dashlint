import { posthog } from './share';

export function shareWeb(): void {
  posthog.capture('wishlist_shared');
}
