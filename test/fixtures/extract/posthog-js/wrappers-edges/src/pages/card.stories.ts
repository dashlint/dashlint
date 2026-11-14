// A story file: skipped, so its wrapper is not user code of this source.
import posthog from 'posthog-js';

export function storyTrack(event: string): void {
  posthog.capture(event);
}
