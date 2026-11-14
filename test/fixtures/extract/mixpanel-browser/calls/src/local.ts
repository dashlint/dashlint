// Negative controls: a `people.set`, a `track` and a `People` interface that are the bookshop's
// own code, not Mixpanel's. None of these calls is an SDK call.
interface People {
  set(prop: Record<string, unknown>): void;
}

const people: People = { set: () => undefined };
const crm = { people };

export function track(name: string, props?: object): void {
  void name;
  void props;
}

export function remember(): void {
  people.set({ loyalty_tier: 'gold' });
  crm.people.set({ loyalty_tier: 'silver' });
  track('local_event_only', { shelf: 'none' });
}
