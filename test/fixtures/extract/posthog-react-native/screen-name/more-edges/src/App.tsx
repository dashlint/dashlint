// More callers that may still capture screens (ADR-047): only a literal false turns one off.
import PostHog, { PostHogProvider } from 'posthog-react-native';

const shared = new PostHog('demo-token');

declare const props: { client?: PostHog };

// autocapture true captures everything.
export function Everything() {
  return (
    <PostHogProvider client={shared} autocapture={true}>
      {null}
    </PostHogProvider>
  );
}

// captureScreens true is on.
export function ScreensOn() {
  return (
    <PostHogProvider client={shared} autocapture={{ captureScreens: true }}>
      {null}
    </PostHogProvider>
  );
}

// A spread beside a literal false may still set autocapture.
export function SpreadBeside() {
  return (
    <PostHogProvider {...props} autocapture={false}>
      {null}
    </PostHogProvider>
  );
}

// A component of the app itself is no caller.
function Shelf(): null {
  return null;
}
export const shelf = <Shelf />;

// The navigation integration with no options keeps its default.
shared.initReactNativeNavigation();

export const restock = () => shared.capture('shelf_restocked', { shelf: 'atlases' });
