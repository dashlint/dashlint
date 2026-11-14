// Provider props in every shape: a spread, no options prop, an options prop that is not an
// expression, a bare options prop, and a literal.
import { PostHogProvider } from 'posthog-react-native';

declare const extra: Record<string, unknown>;

export const Spread = () => (
  <PostHogProvider apiKey="demo-token" {...extra}>
    {null}
  </PostHogProvider>
);

export const NoOptions = () => <PostHogProvider apiKey="demo-token">{null}</PostHogProvider>;

export const TextOptions = () => (
  <PostHogProvider apiKey="demo-token" options="text">
    {null}
  </PostHogProvider>
);

export const BareOptions = () => (
  <PostHogProvider apiKey="demo-token" options>
    {null}
  </PostHogProvider>
);

export const Literal = () => (
  <PostHogProvider apiKey="demo-token" options={{ captureAppLifecycleEvents: false }}>
    {null}
  </PostHogProvider>
);
