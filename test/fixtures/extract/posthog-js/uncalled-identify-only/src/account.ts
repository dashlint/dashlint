// The source initialises posthog-js and identifies the reader, but no event call site of the
// package is found: an event it does not send stays unknown (ADR-069).
import posthog from 'posthog-js';

posthog.init('demo-token', { api_host: 'https://analytics.example.test' });

export function signIn(readerId: string): void {
  posthog.identify(readerId);
}

export function signOut(): void {
  posthog.reset();
}
