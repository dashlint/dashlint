// ADR-070 in a JavaScript file with mixpanel-browser.
import mixpanel from 'mixpanel-browser';

// A: a `null` default with no declared type and a string caller: open.
export const shelfSubmitted = (status, errorMessage = null) => {
  mixpanel.track('Shelf Form Submitted', { status, error_message: errorMessage });
};
shelfSubmitted('error', 'the shelf is full');

// A negative: a JSDoc `{'staff' | null}` keeps its finite set.
/** @param {'staff' | null} [badge=null] */
export function badgeShown(badge = null) {
  mixpanel.track('Badge Shown', { badge });
}

// B: a JSDoc `{Object}` spread: open, no prototype names.
/**
 * @param {string} pageName
 * @param {Object} [properties={}]
 */
export function pageOpened(pageName, properties = {}) {
  mixpanel.track('Page Opened', { pageName, ...properties });
}
pageOpened('catalogue', { genre: 'poetry' });

// B negative: a literal object stays closed.
export function bookShelved() {
  mixpanel.track('Book Shelved', { genre: 'poetry' });
}
