// Wrappers of wrappers that rewrite the properties.
import { trackPayloadName, trackSourcedTwice } from '../lib/edges';

export function moreTill(): void {
  trackSourcedTwice('sourced_twice');
  trackPayloadName('payload_named');
}
