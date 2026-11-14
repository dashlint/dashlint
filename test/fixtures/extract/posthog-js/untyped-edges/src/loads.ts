// How an untyped binding gets an SDK value, and the shapes that give none (T10.2).
declare const require: (...names: unknown[]) => any;
declare function load(name: string): any;
declare const flag: boolean;
declare const other: { all(values: unknown[]): any };

// Promise.allSettled, any and race combine like Promise.all; another object's all does not.
export async function combined(): Promise<void> {
  const settled: any = await Promise.allSettled([import('posthog-js')]);
  settled[0].value.capture('settled_sent');
  const first: any = await Promise.any([import('posthog-js')]);
  first.capture('any_sent');
  const raced: any = await Promise.race([import('posthog-js')]);
  raced.capture('race_sent');
  const notPromise: any = other.all([import('posthog-js')]);
  notPromise.capture('other_all_sent');
}

// Only require and import of a literal name, with one argument, load a package.
export function loaded(): void {
  const twoArgs: any = require('posthog-js', 1);
  twoArgs.capture('two_args_sent');
  const byLoad: any = load('posthog-js');
  byLoad.capture('load_sent');
  const byTemplate: any = require(`posthog-${'js'}`);
  byTemplate.capture('template_sent');
  const leftPad: any = require('left-pad');
  leftPad.capture('left_pad_sent');
}

// The SDK on the second side of a conditional, behind an element access, a typed variable.
export async function sides(): Promise<void> {
  const second: any = flag ? undefined : require('posthog-js');
  second.capture('second_side_sent');
  const sum: any = 1 + require('posthog-js');
  sum.capture('sum_sent');
  const keyed: any = flag ? undefined : require('posthog-js');
  keyed['default'].capture('keyed_sent');
  const pending = import('posthog-js');
  const awaited: any = await pending;
  awaited.capture('awaited_sent');
}

// A typed binding is not untyped even when it holds the SDK.
export function typed(): void {
  const bag: Record<string, any> = flag ? {} : require('posthog-js');
  bag.capture('bag_sent');
}
