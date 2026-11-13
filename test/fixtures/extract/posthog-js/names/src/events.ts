// The shop's event names as types.
export type ShelfEvent = 'shelf_opened' | 'shelf_closed';

export enum ShopEvent {
  Opened = 'shop_opened',
  Closed = 'shop_closed',
}

export enum Aisle {
  Fiction,
  Poetry,
}

export type Genre = 'poetry' | 'drama';

// A finite template literal type: two names.
export type ShelfMove = `shelf_${'top' | 'bottom'}_moved`;

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

// Exactly 50 names, the most one union may give.
export type Aisles50 = `aisle_${'0' | '1' | '2' | '3' | '4'}${Digit}`;

// 51 names: open world, not 51 names.
export type Aisles51 = Aisles50 | 'aisle_extra';

// 17 values; a template of three tiers and a row has 51 names.
export type Row = Digit | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';

export declare function pick<T>(): T;
