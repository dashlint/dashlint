import posthog from 'posthog-js';

export function addToCart(isbn: string): void {
  posthog.capture('cart_book_added', { isbn });
}
