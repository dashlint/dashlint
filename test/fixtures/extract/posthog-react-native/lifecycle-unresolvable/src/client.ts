// The option is computed at run time, so code cannot decide it.
import PostHog from 'posthog-react-native';

declare function readFlag(name: string): boolean;

export const posthog = new PostHog('demo-token', {
  captureAppLifecycleEvents: readFlag('lifecycle'),
});
