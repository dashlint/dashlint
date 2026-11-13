// The same declarations through an aliased import and a value typed by the base class.
import { PostHog as ShopClient, type PostHogCore } from 'posthog-react-native';

const client = new ShopClient('demo-token');
const core: PostHogCore = client;

export function borrowBook(): void {
  client.capture('book_borrowed');
  core.capture('book_renewed');
}
