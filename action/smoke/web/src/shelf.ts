import posthog from 'posthog-js';

export function shareWishlist(genre: 'fiction' | 'poetry'): void {
  posthog.capture('wishlist_shared', { genre_id: genre });
}

export function completeOrder(): void {
  posthog.capture('order_completed', { format: 'ebook' });
}
