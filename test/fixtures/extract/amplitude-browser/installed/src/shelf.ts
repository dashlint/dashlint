// The installed SDK: named imports of the module-level consts, a namespace import, init with its
// options second, and a client from createInstance() whose members are declared in analytics-core.
import * as amplitude from '@amplitude/analytics-browser';
import { createInstance, Identify, identify, init, track } from '@amplitude/analytics-browser';

init('bookshop-key', { autocapture: { attribution: false }, trackingOptions: { language: false } });

export function shelve(): void {
  track('book_shelved', { format: 'hardback' });
}

export function preview(): void {
  amplitude.track({ event_type: 'book_previewed', event_properties: { source: 'window' } });
}

export function visit(): void {
  createInstance().logEvent('store_visited');
}

export function subscribe(): void {
  identify(new Identify().set('newsletter', true));
}
