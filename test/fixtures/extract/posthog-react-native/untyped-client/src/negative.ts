// Negative controls: a typed client stays a normal site; an `any` value that never held the SDK
// gives nothing.
import PostHog from 'posthog-react-native';

const posthog = new PostHog('demo-token');
let reader: any = { capture: (name: string) => name };

export function borrowBook(): void {
  posthog.capture('book_borrowed');
  reader.capture('reader_waved');
}
