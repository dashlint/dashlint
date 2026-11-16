// ADR-070: identify with a JSDoc `{Object}` value says nothing about its keys.
import PostHog from 'posthog-react-native';

export const posthog = new PostHog('demo-token');

/**
 * @param {string} readerId
 * @param {Object} traits
 */
export function rememberReader(readerId, traits) {
  posthog.identify(readerId, traits);
}

// Negative: a literal object keeps its keys.
export function rememberMember(readerId) {
  posthog.identify(readerId, { $set: { plan: 'yearly' } });
}
