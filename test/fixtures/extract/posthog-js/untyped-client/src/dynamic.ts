// A module `let` typed `any` that receives the client from a dynamic import(): its calls cannot be
// matched, so they are open world, never sites.
let shop: any = null;

export function loadAnalytics(): void {
  void import('posthog-js').then((m) => {
    shop = m.default;
  });
}

export function placeOrder(orderId: string): void {
  shop?.capture('order_placed', { order_id: orderId });
  shop.people.set({ last_order: orderId });
}
