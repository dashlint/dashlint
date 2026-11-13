// Validators for the catalog and report contracts (spec T2.1). The schema part runs the standalone
// functions scripts/build-validators.mjs generates (no ajv at runtime, G5); the rules JSON Schema
// cannot express (counts that must agree) run here.
import { validation } from '../report/messages.js';
import type { Catalog } from './catalog.js';
import { catalog as catalogSchema, report as reportSchema } from './generated/validators.js';
import type { Report } from './report.js';

export interface ValidationError {
  /** JSON pointer to the offending field, such as `/identity/0/context`. */
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

interface AjvError {
  instancePath: string;
  params: Record<string, unknown>;
  message?: string;
}

type GeneratedValidator = ((data: unknown) => boolean) & { errors?: AjvError[] | null };

// The rate is written rounded to three decimals (spec 6.3.1 example: 58 / 61 -> 0.951).
const RATE_TOLERANCE = 0.0005 + 1e-9;

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

// Names the field itself: a missing or unexpected property is appended to its parent's path.
function fromAjv(e: AjvError): ValidationError {
  const child = e.params['missingProperty'] ?? e.params['additionalProperty'];
  const path =
    typeof child === 'string' ? `${e.instancePath}/${escapePointer(child)}` : e.instancePath;
  return { path, message: e.message ?? validation.schemaMismatch };
}

function runSchema(validator: GeneratedValidator, data: unknown): ValidationError[] {
  if (validator(data)) return [];
  return (validator.errors ?? []).map(fromAjv);
}

function catalogRules(c: Catalog): ValidationError[] {
  const errors: ValidationError[] = [];
  const { callSites, literalNameSites, openSites, nameResolutionRate } = c.coverage;
  for (const [field, value] of [
    ['literalNameSites', literalNameSites],
    ['openSites', openSites],
  ] as const) {
    if (value > callSites)
      errors.push({ path: `/coverage/${field}`, message: validation.countAboveCallSites(field) });
  }
  if (
    callSites > 0 &&
    literalNameSites <= callSites &&
    Math.abs(nameResolutionRate - literalNameSites / callSites) > RATE_TOLERANCE
  ) {
    errors.push({
      path: '/coverage/nameResolutionRate',
      message: validation.rateMismatch(nameResolutionRate, literalNameSites, callSites),
    });
  }
  for (const [name, event] of Object.entries(c.events)) {
    if (event.openSites > event.sites.length) {
      errors.push({
        path: `/events/${escapePointer(name)}/openSites`,
        message: validation.openSitesAboveSites(event.openSites, event.sites.length),
      });
    }
  }
  return errors;
}

export function validateCatalog(data: unknown): ValidationResult<Catalog> {
  const schemaErrors = runSchema(catalogSchema as GeneratedValidator, data);
  if (schemaErrors.length) return { ok: false, errors: schemaErrors };
  const value = data as Catalog;
  const ruleErrors = catalogRules(value);
  return ruleErrors.length ? { ok: false, errors: ruleErrors } : { ok: true, value };
}

export function validateReport(data: unknown): ValidationResult<Report> {
  const errors = runSchema(reportSchema as GeneratedValidator, data);
  return errors.length ? { ok: false, errors } : { ok: true, value: data as Report };
}

export function formatValidationErrors(errors: ValidationError[]): string[] {
  return errors.map((e) => validation.error(e.path, e.message));
}
