// The bookshop's app: init(apiKey, userId, options) with app lifecycles on and element
// interactions left out; the reader's plan through an Identify object.
import { Identify, identify, init, reset, setUserId } from '@amplitude/analytics-react-native';

init('bookshop-key', undefined, {
  autocapture: { appLifecycles: true },
  trackingSessionEvents: true,
});

export function signIn(readerId: string): void {
  setUserId(readerId);
  identify(new Identify().set('plan', 'member').setOnce('joined_year', 2026));
}

export function signOut(): void {
  reset();
}
