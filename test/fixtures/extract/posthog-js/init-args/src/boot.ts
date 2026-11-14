// The arguments come from a spread, so the options position cannot be known.
import posthog from 'posthog-js';

declare const rest: [string, { capture_pageview: false }];

posthog.init(...rest);
