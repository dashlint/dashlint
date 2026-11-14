// identify and register at the edges of reading their objects (T10.2).
import PostHog from 'posthog-react-native';

export const posthog = new PostHog('demo-token');

declare const flag: boolean;
declare const bag: Record<string, string>;
declare const closed: { email: string };
declare const either: { email: string } | { nickname: string };
declare const plain: object;
declare const withOnce: { $set_once?: { badge: string } };
declare const args: [string, Record<string, unknown>];

export function edges(readerId: string): void {
  posthog.identify(readerId);
  posthog.identify(readerId, bag);
  posthog.identify(readerId, { ...(flag ? { $set: { plan: 'trial' } } : {}), email: 'x' });
  posthog.identify(readerId, { $set: bag });
  posthog.identify(readerId, { nickname: 'n', $groups: { shop: 's' }, $set_once: { since: '1' } });
  posthog.identify(readerId, closed);
  posthog.identify(readerId, either);
  posthog.identify(readerId, plain);
  posthog.identify(readerId, withOnce);
  posthog.identify(readerId, {});
  posthog.identify(...args);
  posthog.register();
  posthog.register(...[{ shelf: 'a' }]);
}
