// package.json names @segment/analytics-next, but the shop uses the snippet's global client of its
// own type: no call of the package is found (ADR-069).
declare global {
  interface Window {
    shopAnalytics?: { track(event: string): void };
  }
}

export function previewBook(): void {
  window.shopAnalytics?.track('Book Previewed');
}
