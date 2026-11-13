// With exactOptionalPropertyTypes an optional property's type has no `undefined`: the `?` alone
// makes it sometimes.
import posthog from 'posthog-js';

interface ReviewProps {
  title: string;
  rating?: number;
}
declare const review: ReviewProps;

export function exact(): void {
  posthog.capture('review_saved', review);
}
