import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
const strict = { additionalProperties: false } as const;
const hex = Type.String({ pattern: '^[0-9a-f]{64}$' });
const nullable = Type.Union([Type.String(), Type.Null()]);
const choices = <T extends string>(values: T[]) => Type.Unsafe<T>(Type.Union(values.map(value => Type.Literal(value))));
const date = Type.String({ format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T.*Z$' });
export const SignatureSchema = Type.Object({ kind: choices(['build', 'test', 'tool', 'verifier']), tool: choices(['anchor','cargo','rustc','surfpool','node','tsc','solana','other']), code: nullable, normalized: Type.String({ minLength: 20, maxLength: 240 }), key: hex }, strict);
export const ApplicabilitySchema = Type.Object({ framework: choices(['anchor','pinocchio','native','kit','web3js','other']), versions: Type.Object({ 'anchor-lang': nullable, '@solana/kit': nullable, surfpool: nullable, agave: nullable, rustc: nullable, node: nullable }, strict), range: Type.Record(Type.String(), Type.String()) }, strict);
export const BodySchema = Type.Object({ symptom: Type.String({ maxLength: 300 }), rootCause: Type.String({ maxLength: 400 }), fixPattern: Type.String({ maxLength: 600 }), avoid: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]) }, strict);
export const VerificationSchema = Type.Object({ evidenceTag: hex, verifierDigest: hex, executionIdentity: hex, mode: Type.Literal('offline-snapshot'), reopenCountBefore: Type.Integer({ minimum: 1 }), failureDigest: hex, at: date }, strict);
export const ProvenanceSchema = Type.Union([
  Type.Object({ source: Type.Literal('bench'), split: Type.Literal('dev'), taskHash: hex, suiteDigest: hex, runId: Type.String({ minLength: 1 }) }, strict),
  Type.Object({ source: Type.Literal('user'), sub: hex }, strict),
  Type.Object({ source: Type.Literal('local') }, strict),
]);
export const LessonSchema = Type.Object({ schema: Type.Literal('oms.lesson/1'), id: Type.String({ minLength: 1 }), version: Type.Integer({ minimum: 1 }), signature: SignatureSchema, applicability: ApplicabilitySchema, body: BodySchema, fixKey: hex, evidence: Type.Array(VerificationSchema, { minItems: 1 }), provenance: Type.Array(ProvenanceSchema, { minItems: 1 }), tier: choices(['quarantined','corroborated','verified','retired']), confirmations: Type.Object({ closed: Type.Integer({ minimum: 0 }), notClosed: Type.Integer({ minimum: 0 }), distinctSources: Type.Integer({ minimum: 0 }) }, strict), refs: Type.Array(Type.Object({ kind: choices(['doc','se','gh']), url: Type.String({ pattern: '^https://' }) }, strict)), createdAt: date, updatedAt: date }, strict);
export type Applicability = Static<typeof ApplicabilitySchema>;
export type LessonBody = Static<typeof BodySchema>;
export type VerificationDigest = Static<typeof VerificationSchema>;
export type Lesson = Static<typeof LessonSchema>;
export function parseLesson(value: unknown): Lesson {
  if (!Value.Check(LessonSchema, value)) throw new TypeError('Invalid lesson');
  return value;
}
