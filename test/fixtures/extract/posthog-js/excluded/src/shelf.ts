import posthog from 'posthog-js';

export function shareWishlist(): void {
  posthog.capture('wishlist_shared');
}
