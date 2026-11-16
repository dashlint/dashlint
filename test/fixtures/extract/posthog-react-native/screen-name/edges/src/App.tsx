// Callers that may still capture screens: each keeps $screen_name unknown (ADR-047).
import PostHog, { PostHogProvider } from 'posthog-react-native';

const shared = new PostHog('demo-token');

declare const props: { autocapture?: boolean };

// A spread may set autocapture.
export function Spread() {
  return (
    <PostHogProvider client={shared} {...props}>
      {null}
    </PostHogProvider>
  );
}

// `autocapture` alone is true: capture everything.
export function All() {
  return (
    <PostHogProvider client={shared} autocapture>
      {null}
    </PostHogProvider>
  );
}

// captureScreens is not a literal false.
declare const screens: boolean;
export function Unresolved() {
  return (
    <PostHogProvider client={shared} autocapture={{ captureScreens: screens }}>
      {null}
    </PostHogProvider>
  );
}

// The wix navigation integration captures screens unless told not to.
shared.initReactNativeNavigation({ navigation: {} });
shared.initReactNativeNavigation({ captureScreens: false });

export const stocktake = () => shared.capture('stock_counted', { shelf: 'poetry' });
