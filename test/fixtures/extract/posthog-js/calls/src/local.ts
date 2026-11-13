// Same names, the user's own code: never SDK sites.
function capture(name: string): string {
  return name;
}

class PostHog {
  capture(name: string): string {
    return name;
  }
}

export function wrapGift(): void {
  capture('gift_wrapped');
  new PostHog().capture('gift_tagged');
}
