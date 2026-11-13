import { posthog } from './share';

export function shareIos(): void {
  posthog.capture('wishlist_shared');
}
