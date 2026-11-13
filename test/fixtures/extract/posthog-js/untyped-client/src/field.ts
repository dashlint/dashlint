// A class field typed `any` that holds a client made with `new` of a required SDK class.
declare const require: (name: string) => any;

export class ShelfTracker {
  private client: any = null;

  start(): void {
    this.client = new (require('posthog-js').PostHog)();
  }

  shelve(isbn: string): void {
    this.client.capture('book_shelved', { isbn });
  }
}
