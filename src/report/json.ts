// The JSON report (spec 6.9.4): `dashlint.report/1` exactly as built (ADR-048), two-space indented.
// The schema is the contract, so a report that does not validate is a bug and is never written.
import type { Report } from '../formats/report.js';
import { formatValidationErrors, validateReport } from '../formats/validate.js';
import type { ReportModel } from './build.js';
import { reportText } from './messages.js';

/** A built report broke its own schema: a bug in dashlint (exit 3), never the user's input. */
export class InvalidReportError extends Error {
  constructor(readonly errors: string[]) {
    super(reportText.invalidReport(errors));
    this.name = 'InvalidReportError';
  }
}

export function renderJson(model: ReportModel | Report): string {
  const report = 'report' in model ? model.report : model;
  const text = JSON.stringify(report, null, 2);
  const v = validateReport(JSON.parse(text));
  if (!v.ok) throw new InvalidReportError(formatValidationErrors(v.errors));
  return `${text}\n`;
}
