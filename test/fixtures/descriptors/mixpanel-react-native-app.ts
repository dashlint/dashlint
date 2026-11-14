// A bookshop React Native app calling mixpanel-react-native with the package not installed: every
// call must resolve to a declaration in descriptors/stubs/mixpanel-react-native.d.ts.
import { Mixpanel } from 'mixpanel-react-native';

const mixpanel = new Mixpanel('bookshop-token', true);
void mixpanel.init();
mixpanel.track('book_shelved', { shelf: 'fiction' });
mixpanel.trackWithGroups('book_shelved', { shelf: 'poetry' }, { branch: 'harbour street' });
mixpanel.registerSuperProperties({ store: 'harbour street' });
mixpanel.registerSuperPropertiesOnce({ first_visit: true });
void mixpanel.identify('reader-1');
mixpanel.getPeople().set({ favourite_genre: 'poetry' });
mixpanel.getPeople().setOnce('first_genre', 'poetry');
mixpanel.reset();

export async function openShelf(): Promise<void> {
  const other = await Mixpanel.init('bookshop-token', false);
  other.track('reading_list_opened');
}
