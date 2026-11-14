// The first round marks only a function's return value; the binding it fills is marked in the
// second round (T10.2).
declare const require: (name: string) => any;

let shop: any;

export function init(): void {
  shop = getClient();
}

export function getClient(): any {
  return require('posthog-js');
}

export function use(): void {
  shop.capture('shop_sent');
}
