import { mixpanel } from './client';

export function borrow(format: 'paperback' | 'audiobook'): void {
  mixpanel.track('book_borrowed', { format });
}

export function reserve(branch: string): void {
  mixpanel.trackWithGroups('book_reserved', { format: 'paperback' }, { branch_id: branch });
}

// Negative control: the bookshop's own People class, not Mixpanel's.
class People {
  set(props: Record<string, unknown>): void {
    void props;
  }
}

export function remember(): void {
  new People().set({ loyalty_tier: 'gold' });
}
