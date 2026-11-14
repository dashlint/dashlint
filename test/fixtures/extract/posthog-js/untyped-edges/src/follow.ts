// Following receivers and values back, and the names with nothing to follow (T10.2).
declare const require: (...names: unknown[]) => any;
declare function later(get: () => unknown): void;
declare function run(fn: (m: any) => void): void;

export class Shelf {
  client: any = require('posthog-js');

  go(): void {
    this.client.capture('field_sent');
  }
}

// Values with no declaration, no symbol or a cycle give nothing, and nothing throws.
export function nothing(p: any): void {
  p.capture('param_sent');
  (undefined as any).capture('undefined_sent');
  notDeclared.capture('undeclared_sent');
  const fromUndefined: any = undefined;
  fromUndefined.capture('from_undefined_sent');
  const fromUndeclared: any = notDeclaredEither;
  fromUndeclared.capture('from_undeclared_sent');
  const loopA: any = loopB;
  const loopB: any = loopA;
  loopA.capture('loop_sent');
  const fromParam: any = p;
  fromParam.capture('from_param_sent');
}

// Callbacks: then with two arguments carries the SDK; catch and a plain call do not.
let viaThen: any;
let viaCatch: any;
let viaRun: any;
export function callbacks(): void {
  import('posthog-js').then(
    (m: any) => {
      viaThen = m.default;
    },
    () => undefined,
  );
  import('posthog-js').catch((m: any) => {
    viaCatch = m;
  });
  run((m: any) => {
    viaRun = m;
  });
  viaThen.capture('then_sent');
  viaCatch.capture('catch_sent');
  viaRun.capture('run_sent');
}

// Return values: only an untyped return type marks the function; an unnamed one is skipped.
export function getTyped(): object {
  return require('posthog-js');
}
export function returns(get = (): any => require('posthog-js')): void {
  (getTyped() as any).capture('typed_return_sent');
  get().capture('default_param_sent');
  later(() => require('posthog-js'));
}

// Arguments: a rest parameter and an argument past the parameters are not marked.
function take(...xs: any): void {
  xs.capture('rest_sent');
}
function one(a: any): void {
  a.capture('one_sent');
}
export function args(): void {
  take(require('posthog-js'));
  one(1, require('posthog-js'));
}

// An import-equals of a namespace member is no package import.
namespace Store {
  export const client: any = 1;
}
import storeClient = Store.client;
export function aliased(): void {
  const fromAlias: any = storeClient;
  fromAlias.capture('alias_sent');
}
