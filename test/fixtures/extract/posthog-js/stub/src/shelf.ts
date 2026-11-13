import posthog from 'posthog-js';

export function shareWishlist(genreId: string): void {
  posthog.capture('wishlist_shared', { genre_id: genreId });
}
