// JavaScript: a module `let` with no type that receives the required client in one function and is
// called in another.
let till = null;

export function openTill() {
  till = require('posthog-js').default;
}

export function closeTill() {
  till.capture('till_closed');
}
