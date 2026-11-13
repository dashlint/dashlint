// Options built from a spread: a key written after it is known, any other key may come from it.
import posthog from 'posthog-js';

declare const shared: Record<string, unknown>;

posthog.init('demo-token', { ...shared, capture_pageview: false });
