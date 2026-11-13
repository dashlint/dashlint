// A bookshop mobile app calling posthog-react-native with the package not installed: every call
// must resolve to a declaration in descriptors/stubs/posthog-react-native.d.ts.
import PostHog, { usePostHog } from 'posthog-react-native';

export const posthog = new PostHog('phc_bookshop', { captureAppLifecycleEvents: false });

posthog.capture('book_shelved', { shelf: 'fiction' });
void posthog.screen('Catalogue', { section: 'new' });
void posthog.register({ store: 'harbour street' });
posthog.identify('reader-1', { $set: { plan: 'member' } });
posthog.setPersonProperties({ favourite_genre: 'poetry' });
posthog.reset();

export function ReadingList() {
  const client = usePostHog();
  client.capture('reading_list_opened');
}
