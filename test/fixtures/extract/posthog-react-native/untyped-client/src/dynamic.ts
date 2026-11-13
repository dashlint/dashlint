// A module `let` typed `any` that receives a client built inside a dynamic import()'s callback.
let client: any = null;

export function loadAnalytics(): void {
  void import('posthog-react-native').then(({ default: PostHog }) => {
    client = new PostHog('demo-token');
  });
}

export function openShelf(shelfId: string): void {
  client.capture('shelf_opened', { shelf_id: shelfId });
}
