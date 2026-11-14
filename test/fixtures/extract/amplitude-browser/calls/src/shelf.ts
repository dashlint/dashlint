// Events through a namespace import, a named import and a client from createInstance(), in the
// name form and the event object form, directly and through a wrapper that passes the object on.
import * as amplitude from '@amplitude/analytics-browser';
import {
  createInstance,
  logEvent,
  track as send,
  type BaseEvent,
} from '@amplitude/analytics-browser';

type Genre = 'fiction' | 'poetry';

export function shelve(genre: Genre): void {
  amplitude.track('book_shelved', { genre, staff_pick: false });
}

export function preview(): void {
  amplitude.track(
    { event_type: 'book_previewed', event_properties: { source: 'shelf' } },
    { device: 'kiosk' },
  );
}

export function wishlist(): void {
  send('wishlist_opened');
}

export function giftCard(): void {
  logEvent(
    { event_type: 'gift_card_bought', event_properties: { amount_band: 'small' } },
    {
      channel: 'web',
    },
  );
}

const kiosk = createInstance();

export function visit(): void {
  kiosk.track('store_visited', { branch: 'harbour street' });
}

function sendEvent(event: BaseEvent): void {
  amplitude.track(event);
}

export function review(): void {
  sendEvent({ event_type: 'review_posted', event_properties: { stars: 5 } });
}
