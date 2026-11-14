// Loans in both track forms, and the screen view helpers.
import {
  createInstance,
  track,
  trackScreenView,
  trackScreenViewOnNavigationStateChange,
  type NavigationState,
} from '@amplitude/analytics-react-native';

export function borrow(format: 'audiobook' | 'paperback'): void {
  track('book_borrowed', { format });
}

export function renew(): void {
  track({ event_type: 'loan_renewed', event_properties: { weeks: 2 } });
}

export function showShelf(): void {
  trackScreenView('Shelf', { tab: 'new' });
}

export function onNavigate(state: NavigationState | undefined): void {
  trackScreenViewOnNavigationStateChange(state);
}

const kiosk = createInstance();

export function checkIn(): void {
  kiosk.trackScreenView('Returns');
}
