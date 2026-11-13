import posthog from 'posthog-js';
import { shelves } from './deep-parse';
import { redeemGiftCard } from './deep-chain';

export function openReader(): void {
  posthog.capture('reader_opened', { shelf_count: shelves.length });
  redeemGiftCard();
}
