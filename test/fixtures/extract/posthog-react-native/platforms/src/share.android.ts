import { posthog } from './share';

export function shareAndroid(): void {
  posthog.capture('wishlist_shared');
}
