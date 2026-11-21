// More ADR-070 B cases in TypeScript: keys a spread never sends.
import posthog from 'posthog-js';

// An interface that extends Object inherits the default library's Object members: never keys.
// The fixture needs the wrapper type itself (ADR-070), so the lint rule is off for this line.
// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
interface Shelf extends Object {
  name: string;
}
export function shelfOpened(shelf: Shelf): void {
  posthog.capture('shelf_opened', { ...shelf });
}

// The same for Function's members (ADR-070), so the lint rule is off for this line.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
interface Hook extends Function {
  label: string;
}
export function hookRan(hook: Hook): void {
  posthog.capture('hook_ran', { ...hook });
}

// A symbol key is never sent; the plain field is.
class Till {
  [Symbol.toStringTag] = 'Till';
  drawer = 1;
}
export function tillOpened(till: Till): void {
  posthog.capture('till_opened', { ...till });
}
