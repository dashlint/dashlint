// The same declaration through an aliased import, a const alias and a detached method.
import { posthog as shopAnalytics } from 'posthog-js';

const tracker = shopAnalytics;
const shelve = tracker.capture.bind(tracker);

export function previewBook(): void {
  shopAnalytics.capture('book_previewed');
  tracker.capture('book_reviewed');
  shelve('book_unshelved');
}
