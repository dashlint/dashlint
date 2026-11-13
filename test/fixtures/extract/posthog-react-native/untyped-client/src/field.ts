// A class field typed `any` that holds a client made with `new` of a required SDK class.
declare const require: (name: string) => any;

export class ReaderAnalytics {
  private client: any = null;

  start(): void {
    this.client = new (require('posthog-react-native').PostHog)('demo-token');
  }

  track(event: string, properties?: Record<string, unknown>): void {
    this.client.capture(event, properties);
  }

  screen(name: string): void {
    this.client.screen(name);
  }
}
