// Events through the default export, a namespace import and a named import.
import mixpanel from 'mixpanel-browser';
import * as analytics from 'mixpanel-browser';
import { track as send } from 'mixpanel-browser';

type Genre = 'fiction' | 'poetry';

export function shelve(genre: Genre): void {
  mixpanel.track('book_shelved', { genre, staff_pick: false });
}

export function preview(): void {
  analytics.track('book_previewed', { source: 'shelf' });
}

export function wishlist(): void {
  send('wishlist_opened');
}

export function reserve(branch: string): void {
  mixpanel.track_with_groups('book_reserved', { format: 'paperback' }, { branch_id: branch });
}

export function landing(): void {
  mixpanel.track_pageview({ section: 'new arrivals' });
}

export function giftCards(): void {
  mixpanel.track_links('#gift-cards a', 'gift_card_link_clicked', () => undefined);
}
