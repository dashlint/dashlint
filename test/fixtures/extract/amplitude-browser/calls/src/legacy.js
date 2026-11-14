// Spec T4.3 negative controls: an event object without event_type, and one whose type is `any`.
// Each is an open-world site, never a name.
import * as amplitude from '@amplitude/analytics-browser';

export function stocktake() {
  amplitude.track({ event_properties: { aisle: 'poetry' } });
}

export function restock(text) {
  const payload = JSON.parse(text);
  amplitude.track(payload);
}
