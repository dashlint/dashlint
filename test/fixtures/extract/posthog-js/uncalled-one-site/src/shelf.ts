// package.json names posthog-js and the source calls it once: the package is seen, so an event no
// site sends is "not sent" as before (ADR-069).
import posthog from 'posthog-js';

export function addToBasket(isbn: string): void {
  posthog.capture('basket_added', { isbn });
}
