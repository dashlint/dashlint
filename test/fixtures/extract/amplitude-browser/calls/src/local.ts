// Negative controls: a `track` function and an `Identify` class that are the bookshop's own code,
// not Amplitude's. None of these calls is an SDK call.
class Identify {
  set(property: string, value: unknown): this {
    void property;
    void value;
    return this;
  }
}

export function track(event: { event_type: string }): void {
  void event;
}

export function remember(): void {
  new Identify().set('loyalty_tier', 'gold');
  track({ event_type: 'local_event_only' });
}
