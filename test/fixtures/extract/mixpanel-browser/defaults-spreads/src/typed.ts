// ADR-070 in TypeScript with mixpanel-browser.
import mixpanel from 'mixpanel-browser';

export function coverZoomed(size: string | null = null): void {
  mixpanel.track('Cover Zoomed', { size });
}

export function formatPicked(format: 'paperback' | null = null): void {
  mixpanel.track('Format Picked', { format });
}

export function shelfFiltered(filters: Record<string, unknown>): void {
  mixpanel.track('Shelf Filtered', { shelf: 'new', ...filters });
}

export function bookRated(rating: { stars: number; staffPick: boolean }): void {
  mixpanel.track('Book Rated', { ...rating });
}

class Basket {
  items = 2;
  total(): number {
    return this.items;
  }
}

export function basketViewed(basket: Basket): void {
  mixpanel.track('Basket Viewed', { ...basket });
}
