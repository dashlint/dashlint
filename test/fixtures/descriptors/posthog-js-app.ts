// A bookshop web app calling posthog-js with the package not installed: every call must resolve
// to a declaration in descriptors/stubs/posthog-js.d.ts.
import posthog, { PostHog } from 'posthog-js';
import { usePostHog } from 'posthog-js/react';

posthog.capture('book_shelved', { shelf: 'fiction' });
posthog.register({ store: 'harbour street' });
posthog.register_once({ first_visit: true });
posthog.identify('reader-1', { plan: 'member' }, { joined: '2026' });
posthog.setPersonProperties({ favourite_genre: 'poetry' });
posthog.people.set({ newsletter: true });
posthog.people.set_once('first_genre', 'poetry');
posthog.reset();

const second = new PostHog();
second.capture('book_previewed');

export function ReadingList() {
  const client = usePostHog();
  client.capture('reading_list_opened');
}
