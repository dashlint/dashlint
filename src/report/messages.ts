// Every user-facing string lives here (spec §6.9.7); scripts/copy-check.mjs checks this file.

// G11: every report ends with this sentence.
export const CLOSING_SENTENCE =
  'A clean result means nothing dashlint can see is broken, not that every number is right.';

// Format validation (src/formats/validate.ts). `path` is a JSON pointer into the file.
export const validation = {
  error: (path: string, message: string) => `${path === '' ? '(top level)' : path}: ${message}`,
  errorAt: (line: number, path: string, message: string) =>
    `line ${line}${path === '' ? '' : `, ${path}`}: ${message}`,
  yamlTag: (tag: string) => `the tag ${tag} is not allowed; dashlint reads plain YAML only`,
  yamlDuplicateKey: (key: string) => `duplicate key "${key}"`,
  yamlSyntax: (detail: string) => `cannot be read as YAML: ${detail}`,
  notFinite: 'is not a finite number',
  schemaMismatch: 'does not match the schema',
  countAboveCallSites: (field: string) => `${field} is greater than callSites`,
  rateMismatch: (rate: number, literal: number, callSites: number) =>
    `nameResolutionRate ${rate} does not equal literalNameSites / callSites (${literal} / ${callSites})`,
  openSitesAboveSites: (openSites: number, sites: number) =>
    `openSites ${openSites} is greater than the number of sites (${sites})`,
  duplicateId: (id: string) => `duplicate id "${id}"`,
  duplicateRef: (ref: string) => `series ref ${ref} is used twice in this tile`,
  duplicateFormulaIndex: (index: number) => `formula index ${index} is used twice in this tile`,
  onlyOnKind: (field: string, kind: string) => `${field} is only allowed on ${kind} tiles`,
  retentionMissing: 'a retention tile needs retention.target and retention.returning',
  notCheckedReasonMissing: (kind: string) =>
    `a ${kind} tile is not checked and needs a notChecked entry for the whole tile with its reason`,
  exclusionSteps: (fromStep: number, toStep: number) =>
    `toStep ${toStep} must be greater than fromStep ${fromStep}`,
  undefinedEventField: (field: string) => `an event that is not defined cannot have ${field}`,
  seenAndNotSeen: (property: string) => `"${property}" is listed as both seen and not seen`,
};

// `dashlint pull` (src/adapters/posthog/pull.ts, src/cli/commands/pull.ts; spec 6.5, 6.8, 6.13).
export const pullMessages = {
  // Spec 6.8: a literal key in the config.
  literalKey: 'Put the key in an environment variable and write `key: env:NAME`.',
  noKey: (name: string) => `no PostHog key: the environment variable ${name} is not set or empty`,
  wrote: (file: string, tiles: number, dashboards: number, alerts: number) =>
    `pull: wrote ${file} (${tiles} tiles, ${dashboards} dashboards, ${alerts} alerts)`,
  // Spec 6.13: said on every pull that is not redacted.
  publicNames:
    'pull: this file holds your insight titles, dashboard names, alert names and filter values. ' +
    'If you commit it to a public repository, they become public. ' +
    'To replace titles with ids and drop the names, set `redact: true` under platforms.posthog.',
  redacted:
    'pull: redact is on: titles are replaced by ids and dashboard, alert and action names are left out. ' +
    'Filter values stay, because the checks need them; on a public repository they become public.',
  failed: (message: string) => `dashlint pull: ${message}`,
  bug: (message: string) => `dashlint pull: unexpected error, please report it: ${message}`,
  usage: 'Usage: dashlint pull [--config <file>]',
  unknownFlag: (flag: string) => `unknown option ${flag}`,
  flagNeedsValue: (flag: string) => `${flag} needs a value`,
  configUnreadable: (file: string, detail: string) => `cannot read the config ${file}: ${detail}`,
  configInvalid: (file: string, error: string) => `${file}: ${error}`,
  configField: (path: string, expected: string) => `${path} must be ${expected}`,
  configMissing: (path: string) => `${path} is missing; pull needs it`,
  requirementsNotJson: (file: string) =>
    `requirements names ${file}; pull writes JSON only (a .yml or .yaml file is written by hand), so point requirements at a .json file`,
  hogqlRefused: (why: string) => `refused a HogQL query before sending it: ${why}`,
  hogqlUnexpected: (why: string) =>
    `the HogQL recency query (POST query/) gave an unexpected answer: ${why}`,
  hogqlAsking: (events: number) =>
    `pull: asking HogQL when the properties of ${events} event${events === 1 ? '' : 's'} last arrived (POST query/, aggregates only)`,
  cannotWrite: (file: string, detail: string) => `cannot write ${file}: ${detail}`,
  actionNotRead: (id: string) => `pull: action ${id} was not found; its tiles are not checked`,
  invalidOutput: (error: string) => `the pulled requirements do not validate: ${error}`,
};

// SDK descriptors, their builtins and stubs (src/descriptors/loader.ts).
export const descriptorErrors = {
  inFile: (file: string, error: string) => `${file}: ${error}`,
  unreadable: (file: string, detail: string) => `cannot read ${file}: ${detail}`,
  memberOrHook: 'a call needs exactly one of member or hook',
  hookAlone: (key: string) => `a hook entry takes no other key, found ${key}`,
  onMissing: 'a member call needs on: the containers that declare it',
  noRole:
    'a member call needs a role: event, superProperties, identity, or personSet or personSetOnce',
  roleConflict: (a: string, b: string) => `${a} and ${b} cannot be on the same call`,
  onlyWithEvent: (key: string) => `${key} is only allowed on a call with event`,
  fallbackNeedsPersonSet: 'personSetFallback needs personSet',
  duplicateCall: (container: string, member: string) => `${container}.${member} is described twice`,
  duplicateHook: (hook: string) => `hook ${hook} is described twice`,
  packageNotDeclaredIn: (pkg: string) => `declaredIn must include the package ${pkg}`,
  verifiedOutsideRange: (verified: string, range: string) =>
    `verified version ${verified} is outside versions ${range}`,
  conditionShape:
    'a condition is always, { option, not }, { option, is } or { unknown }, with nothing else',
  duplicateName: (name: string) => `"${name}" is listed twice`,
  sdkMismatch: (found: string, expected: string) =>
    `sdk is ${found} but the descriptor is ${expected}`,
  duplicateSdk: (sdk: string) => `sdk ${sdk} is described by two descriptors`,
  ingestionCondition:
    'an ingestion row is always or { unknown }: the SDK init options cannot switch it',
  ingestionDuplicate: (name: string, builtins: string) => `"${name}" is also listed in ${builtins}`,
  stubPackageMissing: (pkg: string, stub: string) => `${stub} does not declare module "${pkg}"`,
  stubForeignModule: (module: string, pkg: string, stub: string) =>
    `${stub} declares module "${module}", which is not ${pkg} or one of its subpaths`,
  containerNotInStub: (container: string, stub: string) =>
    `container ${container} is not declared in ${stub}`,
  memberNotInStub: (member: string, container: string, stub: string) =>
    `member ${member} is not declared on ${container} in ${stub}`,
  hookNotInStub: (hook: string, stub: string) => `hook ${hook} is not declared in ${stub}`,
  componentNotInStub: (component: string, stub: string) =>
    `component ${component} is not declared in ${stub}`,
};
