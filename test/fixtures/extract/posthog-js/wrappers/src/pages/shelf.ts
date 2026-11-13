// The sites: calls of the shop's wrappers.
import {
  logLocal,
  ShelfAnalytics,
  track,
  trackOpened,
  trackPayload,
  trackPicked,
  trackRetry,
  trackLater,
  trackShelf,
  trackWeb,
} from '../lib/analytics';
import { useShelfAnalytics } from '../lib/use-shelf-analytics';

export function shelfPage(): void {
  track('shelf_viewed', { shelf: 'fiction' });
  trackShelf('book_unshelved', { genre: 'poetry' });
  trackWeb('book_previewed', { title: 'Dune' });
  trackPayload({ name: 'book_reserved', props: { isbn: '9780441013593' } });
  trackPicked({ name: 'pick_opened' });
  new ShelfAnalytics().log('shelf_sorted');
  trackOpened({ title: 'Dune' });
  trackRetry('sync_failed', 2);
  const send = track;
  send('shelf_shared');
  logLocal('not_sent');
  trackLater('sent_later');
}

export function useShelfPage(): void {
  const { track: sendEvent, trackList, trackGenre } = useShelfAnalytics();
  sendEvent('cover_zoomed', { isbn: '9780441013593' });
  trackList('new_arrivals');
  trackGenre('genre_followed');
}
