/**
 * Structured validation results.
 *
 * Rule: validating untrusted input (a task contract, a pin file, runner
 * evidence) never throws. It returns a list of issues, each with a path into
 * the input, so the caller can show the user exactly which field is wrong.
 */

export interface ValidationIssue {
  /** Location in the input, e.g. `items[2].done[0].expect`. Empty string for the root. */
  path: string;
  code: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/** Alias kept for readability at call sites that validate external input. */
export type ValidationResult<T> = Result<T>;

export function okResult<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failResult(issues: readonly ValidationIssue[]): Result<never> {
  return { ok: false, issues: issues.map((issue) => ({ ...issue })) };
}

export function validationIssue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}
