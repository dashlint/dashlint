// ADR-070 B in TypeScript: what a spread sends by its type.
import posthog from 'posthog-js';

// The global `Object` type accepts any object: open, no prototype names. The fixture needs the
// wrapper type itself, so the lint rule against it is off for this line.
// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
export function genreBrowsed(extra: Object): void {
  posthog.capture('genre_browsed', { genre: 'poetry', ...extra });
}

// An index signature: open, as before.
export function shelfFiltered(filters: Record<string, unknown>): void {
  posthog.capture('shelf_filtered', { shelf: 'new', ...filters });
}

// An object type: closed with its keys, as before.
export function bookRated(rating: { stars: number; staffPick: boolean }): void {
  posthog.capture('book_rated', { ...rating });
}

class Basket {
  items = 2;
  readonly currency = 'EUR';
  total(): number {
    return this.items;
  }
  get empty(): boolean {
    return this.items === 0;
  }
}

// A class instance: its fields, never its methods or accessors.
export function basketViewed(basket: Basket): void {
  posthog.capture('basket_viewed', { ...basket });
}
