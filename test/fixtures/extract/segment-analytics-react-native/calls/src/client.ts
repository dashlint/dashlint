// The client, with app lifecycle events on and deep links left at their default (off).
import { createClient } from '@segment/analytics-react-native';

export const segment = createClient({ writeKey: 'bookshop-demo', trackAppLifecycleEvents: true });
