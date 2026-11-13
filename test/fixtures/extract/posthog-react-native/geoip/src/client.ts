// GeoIP turned off by the client: PostHog still may add $geoip_* (a capture can override the
// option, and the project decides whether the transformation runs), so the names stay unknown.
import PostHog from 'posthog-react-native';

export const posthog = new PostHog('demo-token', {
  host: 'https://analytics.example.test',
  disableGeoip: true,
});

export function openShelf(): void {
  posthog.capture('shelf_opened', { shelf: 'fiction' });
}
