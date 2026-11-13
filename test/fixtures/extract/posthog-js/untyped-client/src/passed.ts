// The client returned as `any`, passed to an `unknown` parameter, and destructured from an alias.
import posthog, { type PostHog } from 'posthog-js';

function shopClient(): any {
  return posthog;
}

export function viewCart(): void {
  shopClient().capture('cart_viewed');
}

function record(client: unknown, name: string): void {
  (client as any).capture(name);
}

export function emptyBasket(): void {
  record(posthog, 'basket_emptied');
  const alias = shopClient();
  const { identify } = alias;
  identify('reader-7');
}

// A typed client read from a property and stored untyped.
export function stash(shelf: { client: PostHog }): void {
  const held: any = shelf.client;
  held.capture('shelf_stashed');
}

// `later` takes its value from `earlier`, which is given the client further down the file.
let later: any = null;

export function useLater(): void {
  later = earlier;
  later.capture('later_captured');
}

let earlier: any = null;

export function fillEarlier(): void {
  earlier = posthog;
}
