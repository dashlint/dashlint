// A fixture value computed once per Stryker mutant (T10.2). A scan made while a test file loads
// runs before Stryker activates the mutant (the vitest runner activates it in a beforeAll), and its
// coverage counts as static, so no assertion on it could kill a mutant of the scanned code. Read the
// value in a beforeEach instead: under plain vitest it is computed once; in Stryker's coverage run
// it is computed again for each test (so each test's coverage is its own); in a mutant run it is
// computed once, with the mutant active.

interface StrykerNamespace {
  activeMutant?: string;
  currentTestId?: string;
}

export function perMutant<T>(make: () => T): () => T {
  let made = false;
  let key: string | undefined;
  let value: T;
  return () => {
    const ns = (globalThis as { __stryker__?: StrykerNamespace }).__stryker__;
    const now = ns ? (ns.activeMutant ?? ns.currentTestId) : undefined;
    if (!made || (ns !== undefined && now !== key)) {
      value = make();
      made = true;
      key = now;
    }
    return value;
  };
}
