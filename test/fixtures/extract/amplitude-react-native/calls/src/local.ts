// Negative controls: the app's own Identify builder and trackScreenView are not Amplitude's.
class Identify {
  set(property: string, value: unknown): this {
    void property;
    void value;
    return this;
  }
}

export function trackScreenView(name: string): void {
  void name;
}

export function remember(): void {
  new Identify().set('loyalty_tier', 'gold');
  trackScreenView('LocalOnly');
}
