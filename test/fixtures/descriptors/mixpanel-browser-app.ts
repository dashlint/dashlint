// A bookshop web app calling mixpanel-browser with the package not installed: every call must
// resolve to a declaration in descriptors/stubs/mixpanel-browser.d.ts, through the default export,
// a namespace import and a named import.
import mixpanel from 'mixpanel-browser';
import * as ns from 'mixpanel-browser';
import { track } from 'mixpanel-browser';

mixpanel.init('bookshop-token', { autocapture: true });
mixpanel.track('book_shelved', { shelf: 'fiction' });
mixpanel.track_with_groups('book_shelved', { shelf: 'poetry' }, { branch: 'harbour street' });
mixpanel.track_pageview({ section: 'new arrivals' });
mixpanel.track_links('#gift-cards a', 'gift_card_link_clicked');
mixpanel.register({ store: 'harbour street' });
mixpanel.identify('reader-1');
mixpanel.people.set({ favourite_genre: 'poetry' });
mixpanel.people.set_once('first_genre', 'poetry');
mixpanel.reset();

ns.track('book_previewed');
ns.register_once({ first_visit: true });
ns.people.set('newsletter', true);
track('reading_list_opened');

const second = mixpanel.init('bookshop-token', {}, 'second');
second.track('book_returned');
