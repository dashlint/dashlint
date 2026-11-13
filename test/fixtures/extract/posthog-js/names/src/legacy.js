// Plain JavaScript: JSDoc types count, and nothing checks what the call is given.
import posthog from 'posthog-js';

/** @type {'gift_wrapped' | 404} */
const code = JSON.parse('404');
/** @type {'gift_sent' | undefined} */
const maybe = JSON.parse('null');

export function wrapGift() {
  posthog.capture(code);
  posthog.capture(maybe);
}
