// A test file: skipped, so neither its calls nor its helpers count.
import { track } from '../lib/analytics';

export function sendForTest(event: string): void {
  track(event);
}

track('test_only');
