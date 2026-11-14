// Wrappers for a capture entry that adds a property from its third argument (a test descriptor).
import posthog from 'posthog-js';

export function trackLabelled(event: string, label: string): void {
  posthog.capture(event, {}, label as any);
}
export function trackFixedLabel(event: string): void {
  posthog.capture(event, {}, 'shelf' as any);
}
export function trackOuter(event: string): void {
  trackFixedLabel(event);
}
export function trackUnlabelled(event: string): void {
  posthog.capture(event);
}
