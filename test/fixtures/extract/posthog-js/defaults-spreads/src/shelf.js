// ADR-070 A: parameters with a `null` default in a JavaScript file.
import posthog from 'posthog-js';

// No declared type and a caller that passes a string: the value is open, not [null].
export const shelfSubmitted = (status, errorMessage = null) => {
  posthog.capture('shelf_form_submitted', { status, error_message: errorMessage });
};
shelfSubmitted('error', 'the shelf is full');

// No declared type and no caller: still open.
export function reviewSaved(note = null) {
  posthog.capture('review_saved', { note });
}

// Destructured with a `null` default: open.
export function shelfMoved({ from = null } = {}) {
  posthog.capture('shelf_moved', { from });
}

// Negative: the JSDoc declares the type `null`, so [null] stays.
/** @param {null} [reason=null] */
export function listCleared(reason = null) {
  posthog.capture('list_cleared', { reason });
}

// Negative: a JSDoc union keeps its finite set.
/** @param {'staff' | null} [badge=null] */
export function badgeShown(badge = null) {
  posthog.capture('badge_shown', { badge });
}

// Negative: a literal `null` written at the call stays [null].
export function noteCleared() {
  posthog.capture('note_cleared', { note: null });
}
