import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { EMPTY_NOTE, REVIEW_DISCLAIMER } from './disclaimer.ts';

export const VULN_CLASSES = [
  'missing-signer', 'missing-owner', 'type-cosplay', 'pda-bump', 'signer-seeds',
  'arbitrary-cpi', 'anchor-cve-2026-45137', 'revival-reinit', 'arithmetic',
  'missing-constraint', 'duplicate-mutable', 'token2022', 'unchecked-sysvar-id',
  'dependency-advisory',
] as const;
export type VulnClass = typeof VULN_CLASSES[number];
const strict = { additionalProperties: false } as const;
const text = Type.String({ maxLength: 4096 });
const nonempty = Type.String({ minLength: 1, maxLength: 4096 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
// Bounds are checked against the snapshot inventory, so invalid locations can be counted.
const line = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const enumeration = <T extends string>(values: readonly T[]) => Type.Enum([...values]);
export const VulnClassSchema = enumeration(VULN_CLASSES);
export const SeveritySchema = enumeration(['critical', 'high', 'medium', 'low', 'info'] as const);
export type Severity = Static<typeof SeveritySchema>;
export const LocationSchema = Type.Object({
  file: nonempty, line, endLine: Type.Optional(line), handler: Type.Optional(text),
}, strict);
export type Location = Static<typeof LocationSchema>;
export const StaticHitSchema = Type.Object({
  tool: enumeration(['oms-sast', 'cargo-audit', 'clippy', 'xray'] as const),
  ruleId: nonempty, class: VulnClassSchema, severity: SeveritySchema,
  location: LocationSchema, message: text,
}, strict);
export type StaticHit = Static<typeof StaticHitSchema>;
export const ModelFindingSchema = Type.Object({
  class: VulnClassSchema, handler: text, location: LocationSchema, title: nonempty,
  explanation: text, fix: text,
  confidence: enumeration(['low', 'medium', 'high'] as const),
}, strict);
export type ModelFinding = Static<typeof ModelFindingSchema>;
export const CoverageSchema = Type.Object({
  class: VulnClassSchema, verdict: enumeration(['found', 'clear', 'n/a', 'unreviewed'] as const), evidence: text,
}, strict);
export type Coverage = Static<typeof CoverageSchema>;

// Phase A cannot accept or manufacture confirmed findings. Phase B must extend
// this union with oracle-issued evidence, not relax the label to an arbitrary string.
export const FindingSchema = Type.Object({
  id: nonempty, label: Type.Literal('suspected'), class: VulnClassSchema, severity: SeveritySchema,
  title: nonempty, location: LocationSchema,
  sources: Type.Array(enumeration(['static', 'model', 'mutator'] as const), { minItems: 1, uniqueItems: true }),
  explanation: text, fix: text, staticHits: Type.Array(StaticHitSchema),
}, strict);
export type Finding = Static<typeof FindingSchema>;
export const ReviewReportSchema = Type.Object({
  schema: Type.Literal('oms.review/1'), disclaimer: Type.Literal(REVIEW_DISCLAIMER),
  emptyNote: Type.Optional(Type.Literal(EMPTY_NOTE)),
  reviewId: nonempty, createdAt: nonempty,
  repo: Type.Object({ commit: text, dirty: Type.Boolean() }, strict), phase: Type.Literal('A'),
  programs: Type.Array(Type.Object({
    name: nonempty, programId: text, framework: enumeration(['anchor', 'native', 'pinocchio'] as const),
    anchorVersion: Type.Optional(text),
  }, strict)),
  model: Type.Optional(Type.Object({ provider: nonempty, model: nonempty }, strict)),
  tools: Type.Array(Type.Object({
    name: nonempty, version: text, status: enumeration(['ok', 'failed', 'skipped'] as const), reason: Type.Optional(text),
  }, strict)),
  coverage: Type.Array(CoverageSchema, { minItems: 14, maxItems: 14 }), findings: Type.Array(FindingSchema),
  totals: Type.Object({ confirmed: Type.Literal(0), suspected: count, invalidModelOutputs: count }, strict),
}, strict);
export type ReviewReport = Static<typeof ReviewReportSchema>;

export function parseReviewReport(input: unknown): ReviewReport {
  if (!Value.Check(ReviewReportSchema, input)) throw new Error('Invalid review report');
  if (new Set(input.coverage.map(row => row.class)).size !== VULN_CLASSES.length ||
      new Set(input.findings.map(finding => finding.id)).size !== input.findings.length ||
      input.totals.suspected !== input.findings.length ||
      (input.findings.length === 0 ? input.emptyNote !== EMPTY_NOTE : input.emptyNote !== undefined)) throw new Error('Inconsistent review report');
  return input;
}

/** The inventory must come from the filtered snapshot, never from model paths. */
export function validLocation(location: Location, files: ReadonlyMap<string, number>): boolean {
  const { file, line, endLine } = location;
  if (file.includes('\\') || file.startsWith('/') || /^[A-Za-z]:/.test(file) ||
      /[\x00-\x1f\x7f]/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) return false;
  const last = files.get(file);
  return last !== undefined && Number.isSafeInteger(line) && line >= 1 && line <= last &&
    (endLine === undefined || (Number.isSafeInteger(endLine) && endLine >= line && endLine <= last));
}

export function parseModelFindings(inputs: readonly unknown[], files: ReadonlyMap<string, number>): {
  findings: ModelFinding[]; invalidModelOutputs: number;
} {
  const findings: ModelFinding[] = [];
  let invalidModelOutputs = 0;
  for (const input of inputs) {
    if (!Value.Check(ModelFindingSchema, input) || !validLocation(input.location, files)) invalidModelOutputs++;
    else findings.push(input);
  }
  return { findings, invalidModelOutputs };
}
