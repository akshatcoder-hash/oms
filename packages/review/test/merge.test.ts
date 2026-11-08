import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeFindings } from '../src/merge.ts';
import type { StaticHit, ModelFinding } from '../src/types.ts';

const files = new Map([['src/lib.rs', 100]]);
const hit = (line: number, handler = 'withdraw'): StaticHit => ({ tool: 'oms-sast', ruleId: 'missing-signer/field', class: 'missing-signer', severity: 'high', location: { file: 'src/lib.rs', line, handler }, message: 'Missing authority check' });
const model = (line: number): ModelFinding => ({ class: 'missing-signer', handler: 'withdraw', location: { file: 'src/lib.rs', line }, title: 'Authority check', explanation: 'Review the authority check.', fix: 'Add a regression test and signer constraint.', confidence: 'high' });
const severity = { 'missing-signer': 'high' } as const;

test('merges nearby static and model evidence without confirmation or input mutation', () => {
  const inputs = [hit(10), hit(12)];
  const before = structuredClone(inputs);
  const result = mergeFindings(inputs, [model(15)], files, severity);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  assert.equal(finding.label, 'suspected');
  assert.deepEqual(finding.sources, ['static', 'model']);
  assert.equal(finding.staticHits.length, 2);
  assert.equal(finding.fix, model(15).fix);
  assert.deepEqual(inputs, before);
  finding.staticHits[0]!.message = 'changed';
  assert.deepEqual(inputs, before);
});

test('deduplication is deterministic and does not chain beyond five lines', () => {
  const inputs = [hit(20), hit(10), hit(15)];
  const result = mergeFindings(inputs, [], files, severity);
  assert.deepEqual(result, mergeFindings([...inputs].reverse(), [], files, severity));
  assert.deepEqual(result.findings.map(f => f.location.line), [10, 20]);
  assert.equal(new Set(result.findings.map(f => f.id)).size, 2);
  assert.equal(mergeFindings([hit(10), hit(10, 'deposit')], [], files, severity).findings.length, 2);
});

test('invalid locations and unknown fields are rejected and counted', () => {
  const result = mergeFindings([{ ...hit(1), location: { file: '../secret', line: 1 } }],
    [model(101), { ...model(10), label: 'confirmed' }], files, severity);
  assert.deepEqual(result.findings, []);
  assert.equal(result.invalidStaticHits, 1);
  assert.equal(result.invalidModelOutputs, 2);
});

test('model severity comes from trusted rules and missing rules fail closed', () => {
  assert.equal(mergeFindings([], [model(10)], files, severity).findings[0]!.severity, 'high');
  assert.throws(() => mergeFindings([], [model(10)], files, {}), /severity/i);
  const low = { ...hit(10), severity: 'low' as const };
  assert.equal(mergeFindings([low], [model(10)], files, severity).findings[0]!.severity, 'high');
});
