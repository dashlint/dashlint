// Every SDK option is a literal, yet PostHog adds $geoip_* on ingestion: the code cannot tell
// whether the project's GeoIP transformation runs, so those names are unknown, never "not sent".
import posthog from 'posthog-js';

posthog.init('demo-token', {
  api_host: 'https://analytics.example.test',
  capture_pageview: false,
  autocapture: false,
});

export function addToBasket(isbn: string): void {
  posthog.capture('basket_added', { isbn });
}
