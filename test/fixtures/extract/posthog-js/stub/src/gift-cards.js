import posthog from 'posthog-js';

export function redeem() {
  posthog.capture('gift_card_redeemed', { channel: 'web' });
}
