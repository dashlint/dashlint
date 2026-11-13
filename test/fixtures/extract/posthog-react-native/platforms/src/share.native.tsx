import { posthog } from './share';

export function shareNative(): void {
  posthog.capture('wishlist_shared');
}
