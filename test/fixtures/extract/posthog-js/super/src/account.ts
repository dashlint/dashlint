// Person properties in every form, and super and person calls whose argument is open.
import posthog from 'posthog-js';

export function rememberReader(readerId: string, plan: 'monthly' | 'yearly'): void {
  posthog.identify(readerId, { plan, favourite_genre: 'poetry' }, { first_shelf: 'classics' });
  posthog.setPersonProperties({ loyalty_tier: 'gold' });
  posthog.people.set({ newsletter: true });
  posthog.people.set('reading_goal', '12');
  posthog.people.set_once('joined_via', 'gift_card');
}

export function tagReader(field: string, extra: Record<string, string>): void {
  posthog.people.set(field, 'yes');
  posthog.register(extra);
}

export function quietIdentify(readerId: string): void {
  posthog.identify(readerId);
}
