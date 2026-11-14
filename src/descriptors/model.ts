// The SDK descriptor model (spec 6.3.3, T3.1): what an analytics SDK's calls mean, as data. The
// JSON Schemas in schema/ are the contract; these types mirror them, and src/descriptors/loader.ts
// checks the rules the schemas cannot express.

export type Platform = 'web' | 'ios' | 'android';

/** A call argument by position, optionally followed by object keys: `args[0]`, `args[1].$set`. */
export type ArgPath = string;

/**
 * The container of a function declared at module level (`export function track` in
 * mixpanel-browser), called through a namespace import or a named import (ADR-054).
 */
export const MODULE_CONTAINER = '(module)';

/** When the object at `personSet` is absent, the SDK sets the keys of `from`, less `omit`. */
export interface PersonSetFallback {
  from: ArgPath;
  omit: string[];
}

/**
 * A member matched by its resolved declaration (spec 6.4 item 3). It has one role: an event site
 * (`event`), super properties (`superProperties`), identity (`identity`, which may also set person
 * properties) or person properties alone (`personSet`, `personSetOnce`).
 */
export interface MemberCall {
  member: string;
  /**
   * Containers that declare the member: a class or interface, `Class.property` for a member of an
   * object-typed property, or `(module)` for a module-level function.
   */
  on: string[];
  event?: ArgPath | { literal: string };
  /** The properties argument; a list is merged in order, a later key overwriting an earlier one. */
  properties?: ArgPath | ArgPath[];
  /** Properties the SDK adds to the event from other arguments, by name. */
  addProperties?: Record<string, ArgPath>;
  superProperties?: ArgPath;
  identity?: 'identify' | 'reset';
  personSet?: ArgPath;
  personSetOnce?: ArgPath;
  personSetFallback?: PersonSetFallback;
}

/** A function that returns the client; members called on its result are matched as usual. */
export interface HookCall {
  hook: string;
}

export type CallEntry = MemberCall | HookCall;

/**
 * Where the app creates the client and passes its init options (spec 6.4 item 8, ADR-027): a
 * member call or a constructor (`member: constructor`), with the options at an argument path, or a
 * component whose `options` prop holds them. A component with a `client` prop is handed a client
 * made elsewhere and is not an init.
 */
export type InitEntry = InitCall | InitComponent;

export interface InitCall {
  member: string;
  on: string[];
  options: ArgPath;
}

export interface InitComponent {
  component: string;
  /** The prop that holds the init options. */
  options: string;
}

export function isInitComponent(entry: InitEntry): entry is InitComponent {
  return 'component' in entry;
}

/** Name prefixes that cannot be cited as builtins: requirements on them are not checked (ADR-003). */
export interface UnknownNames {
  events?: string[];
  properties?: string[];
  personProperties?: string[];
}

/** A descriptor file as written (`descriptors/<sdk>.yml`). */
export interface DescriptorFile {
  sdk: string;
  package: string;
  /** Space-separated comparators, all of which must hold: `>=4.0.0 <5.0.0`. */
  versions: string;
  /** The version every member and builtin was checked against (V1, V2). */
  verified: string;
  declaredIn: string[];
  platforms: Platform[];
  calls: CallEntry[];
  /** Where init options are read for builtin conditions; none leaves every option unknown. */
  init?: InitEntry[];
  /** Relative to the descriptor file. */
  builtins: string;
  /**
   * Relative to the descriptor file: what the vendor adds on ingestion (ADR-029), a builtins file
   * whose conditions are `always` or `unknown`. Its rows join `builtins`.
   */
  ingestion?: string;
  /** Relative to the descriptor file. */
  stub: string;
  unknownNames?: UnknownNames;
}

/**
 * When a builtin is sent (ADR-003): `always`; `not`: unless the init option is that literal; `is`:
 * only when the option is a truthy literal; `unknown`: not decidable from code (conditional).
 */
export type BuiltinCondition =
  | 'always'
  | { option: string; not: string | boolean | number }
  | { option: string; is: string | boolean | number }
  | { unknown: string };

export interface BuiltinEvent {
  name: string;
  when: BuiltinCondition;
}

export interface BuiltinProperty {
  name: string;
  /** `*` is every event the SDK sends. */
  events: '*' | string[];
  presence: 'always' | 'sometimes';
  when: BuiltinCondition;
}

export interface BuiltinPersonProperty {
  name: string;
  when: BuiltinCondition;
}

/** A builtins file as written (`descriptors/builtins/<sdk>.yml`). */
export interface Builtins {
  sdk: string;
  events: BuiltinEvent[];
  properties: BuiltinProperty[];
  personProperties: BuiltinPersonProperty[];
}

/** What a stub declares, read from its syntax only. */
export interface StubSurface {
  /** Module names the stub declares (`declare module "posthog-js"`). */
  modules: string[];
  /** Container (or `Container.property`) to its member names. */
  containers: Map<string, Set<string>>;
  /** Functions and constants declared at module level (hooks). */
  functions: Set<string>;
}

/** A descriptor with its builtins and stub loaded and checked against each other. */
export interface Descriptor extends Omit<DescriptorFile, 'builtins' | 'ingestion' | 'stub'> {
  /** Absolute path of the descriptor file. */
  file: string;
  /** The SDK's builtins followed by the vendor's ingestion rows. */
  builtins: Builtins;
  stub: { file: string; modules: string[] };
}

export function isHook(call: CallEntry): call is HookCall {
  return 'hook' in call;
}
