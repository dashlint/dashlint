// The app's own Analytics class, with Segment's container and member names: never an SDK call,
// because the app declares it, not the package.
class Analytics {
  track(name: string, props: Record<string, string>): string[] {
    return [name, ...Object.keys(props)];
  }
  identify(id: string, traits: { loyalty_tier: string }): string {
    return id + traits.loyalty_tier;
  }
}

const analytics = new Analytics();

export function local(): void {
  analytics.track('Local Only', { shelf: 'a' });
  analytics.identify('reader-7', { loyalty_tier: 'gold' });
}
