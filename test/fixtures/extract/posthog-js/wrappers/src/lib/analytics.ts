// The shop's own tracking helpers around the SDK.
import posthog from 'posthog-js';

export type ShelfEvent = 'book_shelved' | 'book_unshelved';

// A wrapper: the event name is a parameter.
export function track(event: string, props?: Record<string, unknown>): void {
  posthog.capture(event, props);
}

// A wrapper of a wrapper.
export const trackShelf = (event: ShelfEvent, props?: { genre: string }): void => {
  track(event, props);
};

// Adds a literal key at every call.
export function trackWeb(event: string, props: { title: string }): void {
  track(event, { ...props, source: 'web' });
}

// The event name and properties read from an object parameter, through a const alias.
export function trackPayload(payload: { name: string; props: { isbn: string } }): void {
  const name = payload.name;
  posthog.capture(name, payload.props);
}

// The same through a destructured parameter, with a default for the properties.
export function trackPicked({ name }: { name: string }, props = { list: 'staff_picks' }): void {
  posthog.capture(name, props);
}

export class ShelfAnalytics {
  log(event: string): void {
    posthog.capture(event);
  }
}

// Not a wrapper: the event name is fixed here, so this call is the site.
export function trackOpened(props: { title: string }): void {
  posthog.capture('reader_opened', props);
}

// Calls itself; the recursion adds nothing.
export function trackRetry(event: string, attempts: number): void {
  posthog.capture(event);
  if (attempts > 0) trackRetry(event, attempts - 1);
}

// Not a wrapper: the parameter never reaches the SDK.
export function logLocal(event: string): void {
  console.log(event);
}

// Not followed: a `let` may change before the call, so the call inside is the site.
export function trackLater(event: string): void {
  let name = event;
  if (name === '') name = 'unnamed_event';
  posthog.capture(name);
}
