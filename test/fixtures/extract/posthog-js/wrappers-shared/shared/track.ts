// Loaded into the app's program through its import, but not one of the app's files: the wrapper
// counts, its own calls are not the app's sites.
import posthog from 'posthog-js';

export function trackShared(event: string): void {
  posthog.capture(event);
}

export function sharedLoaded(): void {
  posthog.capture('shared_loaded');
}
