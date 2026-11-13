// Negative controls: a typed client stays a normal site; `any` values that never held the SDK give
// nothing, even when their members are named like the SDK's.
import posthog, { type PostHog } from 'posthog-js';

let typed: PostHog | null = null;
let bookmark: any = { capture: (name: string) => name };
let ledger: any = null;
declare const window: { posthog: any };

export function setUp(): void {
  typed = posthog;
  ledger = JSON.parse('{}');
}

export function returnBook(): void {
  typed?.capture('book_returned');
  bookmark.capture('bookmark_saved');
  ledger.capture('ledger_balanced');
  window.posthog.capture('receipt_emailed');
}
