// The client AnalyticsBrowser.load() returns, shared by the shop's modules.
import { AnalyticsBrowser } from '@segment/analytics-next';

export const analytics = AnalyticsBrowser.load({ writeKey: 'bookshop-demo' });
