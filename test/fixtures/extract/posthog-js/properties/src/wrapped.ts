// Properties through wrappers: at each call of a wrapper the argument's own type decides, and
// literal keys the wrapper adds are added at every call.
import posthog from 'posthog-js';

export function track(event: string, props?: Record<string, unknown>): void {
  posthog.capture(event, props);
}

export function trackWeb(event: string, props: { title: string }): void {
  track(event, { ...props, source: 'web' });
}

export function trackPayload(payload: {
  name: string;
  props: { isbn: string; edition?: number };
}): void {
  posthog.capture(payload.name, payload.props);
}

export function trackPicked(name: string, props = { list: 'staff_picks' }): void {
  posthog.capture(name, props);
}

export function calls(title: string): void {
  track('reader_joined', { plan: 'monthly' });
  track('reader_left');
  trackWeb('reader_browsed', { title });
  trackPayload({ name: 'reader_scanned', props: { isbn: title } });
  trackPicked('reader_picked');
  trackPicked('reader_chose', { list: 'new_in' });
}

declare const rescan: { name: 'reader_rescanned'; props: { isbn: string; edition?: number } };

export function fromTypes(): void {
  // Not an object literal: the properties are read through the value's type.
  trackPayload(rescan);
}
