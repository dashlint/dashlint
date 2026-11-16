// package.json names posthog-js, but the shop loads the PostHog snippet with a script tag and only
// reads a global of its own type: no call of the package is found, so no event of this source is
// "not sent" from code alone (ADR-069).
declare global {
  interface Window {
    shopTracker?: { capture(event: string): void };
  }
}

export function previewBook(): void {
  window.shopTracker?.capture('book_previewed');
}
