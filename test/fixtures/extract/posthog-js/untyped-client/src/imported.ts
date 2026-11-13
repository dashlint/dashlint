// An SDK import that does not resolve, given to an untyped binding after its declaration, and a
// client returned by an arrow function typed `any`.
import lite from 'posthog-js/dist/module.no-external';
import posthog from 'posthog-js';

let till: any;

export function openTill(): void {
  till = lite;
}

export function closeTill(): void {
  till.capture('till_closed');
}

const shelfClient = (): any => posthog;

export function viewShelf(): void {
  shelfClient().capture('shelf_viewed');
}
