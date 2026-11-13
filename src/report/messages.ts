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
};
