// An untyped client: open world from the SDK scan, in a file after the cut-off's.
import posthog from 'posthog-js';

const client: any = posthog;

export function untyped(): void {
  client.capture('untyped_sent');
}
