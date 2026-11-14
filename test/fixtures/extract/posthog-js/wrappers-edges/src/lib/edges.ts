// Wrapper shapes at the edges of the tracer (T10.2).
import posthog from 'posthog-js';

// Overloads: the call resolves to a signature; the body is the wrapper.
export function trackFormat(event: 'format_chosen'): void;
export function trackFormat(event: string): void;
export function trackFormat(event: string): void {
  posthog.capture(event);
}

const CHIME = 'chime';

export class Till {
  ring(event: 'till_opened'): void;
  ring(event: string): void;
  ring(event: string): void {
    posthog.capture(event);
  }
  #note(event: string): void {
    posthog.capture(event);
  }
  [CHIME](event: string): void {
    posthog.capture(event);
  }
  close(): void {
    this.#note('till_closed');
  }
}

// A method of an anonymous class expression.
export const Counter = class {
  tally(event: string): void {
    posthog.capture(event);
  }
};

// An anonymous and a named function expression held in a const.
export const trackTag = function (event: string): void {
  posthog.capture(event);
};
export const trackNamed = function sendNamed(event: string): void {
  posthog.capture(event);
};

// The name read with a string literal key.
export function trackKeyed(payload: { name: string }): void {
  posthog.capture(payload['name']);
}

// Not followed: a rest parameter, a rest or array pattern, a computed key.
export function trackRest(...events: any): void {
  posthog.capture(events);
}
export function trackRestPicked({ ...rest }: { name: string }): void {
  posthog.capture(rest.name);
}
export function trackFirst([first]: [string]): void {
  posthog.capture(first);
}
export function trackComputed({ ['na' + 'me']: name }: { name: string }): void {
  posthog.capture(name);
}

// Not followed: names with no declaration to trace.
export function sendNothing(): void {
  posthog.capture(undefined as any);
  posthog.capture(notDeclaredAnywhere);
}

// A function held in a parameter default is named by nothing.
export function withSender(send = (event: string): void => posthog.capture(event)): void {
  send('gift_wrapped');
}

// Options from the outer function stay values, not parameters of the inner wrapper.
export function makeTracker(opts: { source: string }) {
  return (event: string): void => {
    posthog.capture(event, opts);
  };
}
export function makeSpreadTracker(opts: { source: string }) {
  return (event: string): void => {
    posthog.capture(event, { ...opts, kind: 'spread' });
  };
}

// Eight const aliases are followed; nine are not.
export function aliased8(event: string): void {
  const a1 = event;
  const a2 = a1;
  const a3 = a2;
  const a4 = a3;
  const a5 = a4;
  const a6 = a5;
  const a7 = a6;
  const a8 = a7;
  posthog.capture(a8);
}
export function aliased9(event: string): void {
  const a1 = event;
  const a2 = a1;
  const a3 = a2;
  const a4 = a3;
  const a5 = a4;
  const a6 = a5;
  const a7 = a6;
  const a8 = a7;
  const a9 = a8;
  posthog.capture(a9);
}

type Deep = { k: { k: { k: { k: { k: { k: { k: { k: { k: string } } } } } } } } };

// Eight property reads are followed; nine are not; the same with string keys.
export function dotted8(p: Deep): void {
  posthog.capture(p.k.k.k.k.k.k.k.k as any);
}
export function dotted9(p: Deep): void {
  posthog.capture(p.k.k.k.k.k.k.k.k.k);
}
export function keyed8(p: Deep): void {
  posthog.capture(p['k']['k']['k']['k']['k']['k']['k']['k'] as any);
}
export function keyed9(p: Deep): void {
  posthog.capture(p['k']['k']['k']['k']['k']['k']['k']['k']['k']);
}

// A wrapper adding a key to its properties parameter, and a wrapper of it.
export function trackSourced(event: string, props: { title: string }): void {
  posthog.capture(event, { ...props, source: 'till' });
}
export function trackSourcedTwice(event: string): void {
  trackSourced(event, { title: 'twice' });
}

// Properties read from a key the outer call's literal does not write.
export function trackPayloadProps(payload: { name: string; props?: { isbn: string } }): void {
  posthog.capture(payload.name, payload.props);
}
export function trackPayloadName(label: string): void {
  trackPayloadProps({ name: label });
}
