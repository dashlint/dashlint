// The provider creates the client; its options come through a const alias. A second provider
// given a client is not an init.
import PostHog, { PostHogProvider } from 'posthog-react-native';

const options = { captureAppLifecycleEvents: false, flushAt: 5 } as const;

export function App() {
  return (
    <PostHogProvider apiKey="demo-token" options={options}>
      {null}
    </PostHogProvider>
  );
}

const shared = new PostHog('demo-token', { captureAppLifecycleEvents: false });

export function Embedded() {
  return <PostHogProvider client={shared}>{null}</PostHogProvider>;
}
