import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.ts';
import { frame } from '../src/frame.ts';
import { securityLint } from '../src/lint/security.ts';
import { capture } from '../src/capture.ts';
test('normalization has no sentinel limit and ignores quoted error codes', () => {
  const repeated = normalize('error: ' + '<id> '.repeat(60), 'build', 'other');
  assert.ok(!/[\u0001\u0002]/.test(repeated.normalized));
  assert.deepEqual(normalize(repeated.normalized, 'build', 'other'), repeated);
  const quoted = normalize("error: name 'E0277' was not recognized by compiler", 'build', 'rustc');
  assert.equal(quoted.code, null);
  assert.deepEqual(normalize(quoted.normalized, 'build', 'rustc'), quoted);
});
test('multiline signer and native owner check removal refuse learning', () => {
  const body = { symptom: 'error', rootCause: 'types', fixPattern: 'compatible types', avoid: null };
  for (const diff of [' #[account(\n- signer,\n )]', '- if owner != program_id { return Err(error); }']) assert.ok(securityLint(diff, body).length);
});
test('frame tests original fields for control characters', () => {
  assert.equal(frame({ id: 'P1', tier: 'verified', confidence: 1, applies: 'anchor', symptom: 'hello\u0001world', fix: 'types', avoid: null }), '');
});
test('capture never retains private identifiers in stored signature', async () => {
  const hex = 'a'.repeat(64);
  const result = await capture({ failure: { reason: 'failed', failureDigest: hex, output: 'error: FreshPrivateSeedXYZ incompatible argument types', reopenCount: 1 }, closure: { closed: true, executionIdentity: hex, evidence: { passed: true, mode: 'offline-snapshot', specificationDigest: hex, codeDigest: hex, verifierDigest: hex, snapshotDigest: hex, at: '2026-11-08T00:00:00Z' } }, applicability: { framework: 'anchor', versions: { 'anchor-lang': null, '@solana/kit': null, surfpool: null, agave: null, rustc: null, node: null }, range: {} }, diff: '', installSalt: 's'.repeat(32), vocabulary: new Set(['error', 'incompatible', 'argument', 'types']), secretForms: ['FreshPrivateSeedXYZ'] });
  assert.ok(result);
  assert.ok(!JSON.stringify(result).includes('FreshPrivateSeedXYZ'));
});
test('applicability tolerates unrelated crate versions', async () => {
  const { applicability } = await import('../src/applicability.ts');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'oms-applicability-'));
  try {
    writeFileSync(join(root, 'Cargo.lock'), '[[package]]\nname = "syn"\nversion = "1.0.0"\n[[package]]\nname = "syn"\nversion = "2.0.0"\n[[package]]\nname = "anchor-lang"\nversion = "1.2.2"');
    assert.equal(applicability(root, { surfpool: null, agave: null, rustc: null, node: null }).versions['anchor-lang'], '1.2.2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('truncation preserves code and normalization idempotence', () => {
  const signature = normalize('error: ' + 'g'.repeat(250) + ' TS2345', 'build', 'tsc');
  assert.equal(signature.code, 'ts:2345');
  assert.ok(signature.normalized.length <= 240);
  assert.deepEqual(normalize(signature.normalized, 'build', 'tsc'), signature);
});
test('security lint refuses reversed and local-variable owner comparisons', () => {
  const body = { symptom: 'error', rootCause: 'types', fixPattern: 'compatible types', avoid: null };
  for (const diff of ['- if program_id != owner { return Err(error); }', '- if account_owner != program_id { return Err(error); }']) assert.ok(securityLint(diff, body).length);
});
