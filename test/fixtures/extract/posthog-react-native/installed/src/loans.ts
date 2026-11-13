import PostHog from 'posthog-react-native';
import { PostHog as Decoy } from 'shelf-analytics';

const posthog = new PostHog('demo-token');
const decoy = new Decoy();

export function lendBook(): void {
  posthog.capture('book_lent');
  posthog.screen('Loans');
  decoy.capture('book_lent');
  decoy.screen('Loans');
}
