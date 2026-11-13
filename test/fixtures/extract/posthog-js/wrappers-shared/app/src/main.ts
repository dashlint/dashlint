// The source analysed is `app`; its tracking helper lives in a shared folder outside it.
import posthog from 'posthog-js';
import { trackShared } from '../../shared/track';

posthog.register({ storefront: 'web' });
trackShared('gift_card_redeemed');
