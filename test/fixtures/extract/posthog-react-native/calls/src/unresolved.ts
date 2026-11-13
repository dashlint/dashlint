// An SDK path the stub does not declare: the hook's client cannot be matched, so open world.
import { usePostHog } from 'posthog-react-native/lib/commonjs/hooks';

export function useRenewals(): void {
  const { capture: track } = usePostHog();
  track('loan_renewed');
}
