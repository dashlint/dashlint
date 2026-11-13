// An SDK subpath the stub does not declare: its calls cannot be matched, so they are open world.
// An unresolved import of another package is not an SDK question.
import lite from 'posthog-js/dist/module.no-external';
import { createForm } from 'shelf-forms';

export function applyCoupon(): void {
  lite.init('demo-token');
  lite.capture('coupon_applied');
  createForm().reset();
}
