// Every way an event name reaches the SDK directly, one call per line.
import posthog from 'posthog-js';
import {
  Aisle,
  pick,
  ShopEvent,
  type Aisles50,
  type Aisles51,
  type Genre,
  type Row,
  type ShelfEvent,
  type ShelfMove,
} from './events';

const SHELVED = 'book_shelved';
const genre = pick<Genre>();
const shelf = pick<ShelfEvent>();
const shop = pick<ShopEvent>();
const tier = pick<'low' | 'mid' | 'high'>();
const row = pick<Row>();
const raw = JSON.parse(pick<string>());
const label = pick<string>();

export function sendAll(): void {
  posthog.capture('book_opened');
  posthog.capture(SHELVED);
  posthog.capture(shelf);
  posthog.capture(ShopEvent.Opened);
  posthog.capture(shop);
  posthog.capture(pick<ShelfMove>());
  posthog.capture(`genre_${genre}_browsed`);
  posthog.capture(pick<Aisles50>());
  posthog.capture(`aisle_${Aisle.Poetry}`);
  posthog.capture(pick<Aisles51>());
  posthog.capture(`${tier}_${row}`);
  posthog.capture(label);
  posthog.capture(raw);
  posthog.capture(pick<`review_${string}`>());
  posthog.capture(String(Aisle.Poetry));
  posthog.capture(`stock_${pick<number>()}`);
  posthog.capture(`floor_${pick<1 | 2>()}`);
  posthog.capture(`gift_${pick<boolean>()}`);
}
