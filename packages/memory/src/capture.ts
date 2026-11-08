import { normalize, sha256 } from './normalize.ts';
import { scrub, scrubBody } from './scrub.ts';
import { securityLint } from './lint/security.ts';
import { shingles } from './score.ts';
import { parseLesson, type Applicability, type Lesson, type LessonBody } from './types.ts';

export interface CaptureFailure { reason: 'failed'; failureDigest: string; output: string; reopenCount: number }
export interface CaptureClosure {
  closed: boolean;
  evidence: { passed: boolean; mode: string; specificationDigest: string; codeDigest: string; verifierDigest: string; snapshotDigest: string; at: string };
  executionIdentity: string;
}
export interface CaptureInput {
  failure?: CaptureFailure;
  closure: CaptureClosure;
  applicability: Applicability;
  diff: string;
  installSalt: string;
  vocabulary: ReadonlySet<string>;
  secretForms: readonly string[];
}
function base32(hex: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, output = '';
  for (const byte of Buffer.from(hex, 'hex')) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(value >>> bits) & 31]; }
  }
  return output;
}
/** Input is supplied only by a trusted host observer, never a tool or MCP argument. */
export async function capture(input: CaptureInput): Promise<{ lesson: Lesson } | null> {
  const { failure, closure } = input;
  if (!failure || failure.reason !== 'failed' || failure.reopenCount < 1 || !closure.closed || !closure.evidence.passed || closure.evidence.mode !== 'offline-snapshot') return null;
  const digests = [failure.failureDigest, closure.executionIdentity, closure.evidence.specificationDigest, closure.evidence.codeDigest, closure.evidence.verifierDigest, closure.evidence.snapshotDigest];
  if (digests.some(value => !/^[0-9a-f]{64}$/.test(value)) || input.installSalt.length < 32) return null;
  const rawSignature = normalize(failure.output, 'verifier', 'other');
  if (rawSignature.normalized.length < 20) return null;
  const template: LessonBody = { symptom: rawSignature.normalized.slice(0, 300), rootCause: 'The earlier independent verification failed.', fixPattern: 'Check the pinned requirements and reproduce the passing offline checks.', avoid: null };
  if (securityLint(input.diff, template).length) return null;
  const safeSignature = scrub(rawSignature.normalized, input.vocabulary, input.secretForms);
  if (safeSignature.text.length < 20) return null;
  const signature = { ...rawSignature, normalized: safeSignature.text, key: sha256(`${rawSignature.kind}|${rawSignature.tool}|${rawSignature.code ?? ''}|${safeSignature.text}`) };
  const safe = scrubBody(template, input.vocabulary, input.secretForms);
  const fixKey = sha256([...shingles(safe.body.fixPattern)].sort().join('|'));
  const at = closure.evidence.at;
  const evidenceKey = [closure.evidence.specificationDigest, closure.evidence.codeDigest, closure.evidence.verifierDigest, closure.evidence.snapshotDigest].join(':');
  const lesson = parseLesson({ schema: 'oms.lesson/1', id: 'P' + base32(sha256(`${signature.key}|${fixKey}`)).slice(0, 16), version: 1, signature, applicability: input.applicability, body: safe.body, fixKey, evidence: [{ evidenceTag: sha256(input.installSalt + evidenceKey), verifierDigest: closure.evidence.verifierDigest, executionIdentity: closure.executionIdentity, mode: 'offline-snapshot', reopenCountBefore: failure.reopenCount, failureDigest: failure.failureDigest, at }], provenance: [{ source: 'local' }], tier: 'quarantined', confirmations: { closed: 1, notClosed: 0, distinctSources: 1 }, refs: [], createdAt: at, updatedAt: at });
  return { lesson };
}
