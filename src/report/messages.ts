// Every user-facing string lives here (spec §6.9.7); scripts/copy-check.mjs checks this file.

// G11: every report ends with this sentence.
export const CLOSING_SENTENCE =
  'A clean result means nothing dashlint can see is broken, not that every number is right.';

// Format validation (src/formats/validate.ts). `path` is a JSON pointer into the file.
export const validation = {
  error: (path: string, message: string) => `${path === '' ? '(top level)' : path}: ${message}`,
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
