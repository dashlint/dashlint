// The bookshop's React Native client.
import { Mixpanel } from 'mixpanel-react-native';

export const mixpanel = new Mixpanel('bookshop-token', true);
void mixpanel.init();
mixpanel.registerSuperProperties({ store: 'harbour street' });
mixpanel.registerSuperPropertiesOnce({ first_launch: true });

export async function signIn(readerId: string): Promise<void> {
  await mixpanel.identify(readerId);
  mixpanel.getPeople().set({ plan: 'member' });
  const people = mixpanel.getPeople();
  people.set('favourite_genre', 'poetry');
  people.setOnce({ joined_year: 2026 });
}

export function signOut(): void {
  mixpanel.reset();
}
