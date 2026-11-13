// reset in each syntactic context (ADR-027). No React types: only the syntax matters here.
import posthog from 'posthog-js';

declare function useEffect(effect: () => void, deps?: unknown[]): void;
declare function loadShelf(): Promise<void>;

export function ShelfPage(props: { readerId: string }) {
  useEffect(() => {
    posthog.reset();
  }, []);
  useEffect(() => {
    loadShelf().then(() => posthog.reset());
  }, []);
  useEffect(() => {
    posthog.reset();
  }, [props.readerId]);
  return <button onClick={() => posthog.reset()}>Leave shelf</button>;
}

export function handleCheckout(): void {
  posthog.reset();
}

export const signOut = (): void => {
  posthog.reset();
};

export function clearBasket(): void {
  posthog.reset();
}

window.addEventListener('pagehide', () => posthog.reset());

export class Wishlist {
  componentDidMount(): void {
    posthog.reset();
  }
}
