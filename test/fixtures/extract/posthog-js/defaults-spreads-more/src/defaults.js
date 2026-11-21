// More ADR-070 A cases in JavaScript.
import posthog from 'posthog-js';

// An `undefined` default with no declared type: open, and callers may leave it out.
export function wishSaved(title = undefined) {
  posthog.capture('wish_saved', { title });
}

// Negative: a default that is neither null nor undefined is read from its type as before.
export function aisleVisited(aisle = 'poetry') {
  posthog.capture('aisle_visited', { aisle });
}

// A `null` default read through parentheses: still open. The parentheses are the case, so
// prettier leaves this line as written.
export function tagAdded(tag = null) {
  // prettier-ignore
  posthog.capture('tag_added', { tag: (tag) });
}

// A name nothing declares: open, and the scan goes on.
export function ghostSeen() {
  posthog.capture('ghost_seen', { ghost: undeclaredGhost });
}
