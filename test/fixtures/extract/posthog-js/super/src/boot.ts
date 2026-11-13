// Runs when the module loads: init with literal options, super properties, and a reset at startup.
import posthog from 'posthog-js';

const shelfTheme: 'light' | 'dark' = Math.random() > 0.5 ? 'light' : 'dark';

posthog.init('demo-token', {
  capture_pageview: false,
  autocapture: { dom_event_allowlist: ['click'] },
  person_profiles: 'identified_only',
});

posthog.register({ storefront: 'web', shelf_theme: shelfTheme });
posthog.register_once({ storefront: 'kiosk', first_visit: true });

posthog.reset();
