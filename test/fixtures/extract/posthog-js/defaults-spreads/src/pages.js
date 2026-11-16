// ADR-070 B: a JSDoc `{Object}` parameter spread into the properties.
import posthog from 'posthog-js';

/**
 * @param {string} pageName
 * @param {Object} [properties={}]
 */
export function pageOpened(pageName, properties = {}) {
  posthog.capture('page_opened', { pageName, ...properties });
}
pageOpened('catalogue', { genre: 'poetry' });

// Negative: an object literal spread stays closed with its keys.
export function bookShelved() {
  posthog.capture('book_shelved', { ...{ genre: 'poetry' } });
}
