// Each binding takes the SDK from the next one, written in reverse, so marking takes one round per
// link: five rounds reach `b`, and `a` would need a sixth (T10.2).
declare const require: (name: string) => any;

let a: any;
let b: any;
let c: any;
let d: any;
let e: any;
let f: any;

export function wire(): void {
  a = b;
  b = c;
  c = d;
  d = e;
  e = f;
  f = require('posthog-js');
}

export function use(): void {
  a.capture('a_sent');
  b.capture('b_sent');
}
