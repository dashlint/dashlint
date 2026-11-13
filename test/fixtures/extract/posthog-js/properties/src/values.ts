// Values: finite sets from literals, unions, `boolean` and enums; open values with their type.
import posthog from 'posthog-js';

export enum Format {
  Paper = 'paper',
  Ebook = 'ebook',
}
export enum Shelf {
  Top = 1,
  Bottom = 2,
}
type Channel = 'link' | 'email';
type Aisle50 = `aisle_${0 | 1 | 2 | 3 | 4}${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
type Aisle = Aisle50 | 'aisle_extra';

declare const channel: Channel;
declare const giftWrapped: boolean;
declare const format: Format;
declare const shelf: Shelf;
declare const aisle: Aisle;
declare const aisle50: Aisle50;
declare const title: string;
declare const pages: number;
declare const tags: string[];
declare const author: { name: string };
declare const coupon: string | null;
declare const code: string | number;
declare const anything: unknown;

export function literals(): void {
  // JSON types are kept: true, "true", 3 and null are four different kinds of value.
  posthog.capture('book_opened', {
    channel: 'link',
    in_stock: true,
    stocked: 'true',
    copies: 3,
    note: null,
  });
}

export function finiteFromTypes(): void {
  const wrap = giftWrapped ? 'yes' : 'no';
  posthog.capture('book_shared', {
    channel,
    gift_wrapped: giftWrapped,
    format,
    shelf,
    top: Shelf.Top,
    wrap,
  });
}

export function openValues(): void {
  // `aisle` has 51 values, one more than a finite set holds; `aisle50` exactly 50.
  posthog.capture('book_read', {
    title,
    pages,
    tags,
    author,
    coupon,
    code,
    anything,
    aisle,
    aisle50,
  });
}

export function againWithStrings(): void {
  // The same event from a second site: its values are added, `true` and "true" stay apart.
  posthog.capture('book_opened', { channel: 'email', in_stock: 'true', copies: 3 });
}
