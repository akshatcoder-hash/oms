import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSastResult, SAST_OUTPUT_BYTES } from '../src/static/sast.ts';

const inventory = new Map([['src/lib.rs', 4], ['other.rs', 4]]);
const hit = {
  tool: 'oms-sast', ruleId: 'missing-signer/anchor-field', class: 'missing-signer', severity: 'high',
  location: { file: 'src/lib.rs', line: 2 }, message: 'Authority requires review',
};
const envelope = () => ({ hits: [hit], handlers: [], implementedRules: [hit.ruleId] });
function parse(value: unknown) {
  return parseSastResult({ exitCode: 0, timedOut: false, truncated: false, stdout: JSON.stringify(value) }, 'src/lib.rs', inventory);
}

test('static output retains suspected hits and limited rule inventory without a clear verdict', () => {
  const result = parse(envelope());
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.hits, [hit]);
  assert.deepEqual(result.implementedRules, [hit.ruleId]);
  assert.equal(result.invalidOutputs, 0);
  assert.equal(parse({ ...envelope(), hits: [] }).status, 'ok');
  assert.equal('coverage' in result, false);
  assert.equal('label' in result.hits[0]!, false);
});

test('crashes, timeouts, truncation and invalid JSON cannot become clean scans', () => {
  const base = { exitCode: 0, timedOut: false, truncated: false, stdout: JSON.stringify(envelope()) };
  for (const change of [
    { exitCode: 1 }, { exitCode: null }, { timedOut: true }, { truncated: true },
    { stdout: '{broken' }, { stdout: '' }, { stdout: 'é'.repeat(SAST_OUTPUT_BYTES / 2 + 1) },
  ]) {
    const result = parseSastResult({ ...base, ...change }, 'src/lib.rs', inventory);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.hits, []);
    assert.deepEqual(result.implementedRules, []);
    assert.ok(result.reason);
  }
});

test('strict static envelopes refuse unknown keys, duplicate rules and excessive entry counts', () => {
  for (const value of [
    null, [], {}, { ...envelope(), confirmed: true }, 
    { ...envelope(), implementedRules: [hit.ruleId, hit.ruleId] },
    { ...envelope(), implementedRules: ['unknown/rule'] },
    { ...envelope(), implementedRules: ['missing-signer/../../escape'] },
    { ...envelope(), implementedRules: ['missing-signer/' + '1'.repeat(64)] },
    { ...envelope(), implementedRules: ['missing-signer/' + 'a'.repeat(64)] },
    { ...envelope(), hits: Array(10_001).fill(hit) },
  ]) assert.equal(parse(value).status, 'failed');
});

test('invalid entries are dropped and counted without losing valid static signals', () => {
  const invalid = [
    { ...hit, label: 'confirmed' }, { ...hit, tool: 'xray' },
    { ...hit, message: 'é'.repeat(2049) },
    { ...hit, ruleId: 'missing-signer/not-executed' }, { ...hit, class: 'arithmetic' },
    ...['../escape.rs', '/tmp/escape.rs', 'src/../lib.rs', 'other.rs'].map(file => ({ ...hit, location: { file, line: 1 } })),
    ...[0, -1, 5, 1.5].map(line => ({ ...hit, location: { file: 'src/lib.rs', line } })),
    { ...hit, location: { ...hit.location, endLine: 1 } },
  ];
  const result = parse({ ...envelope(), hits: [hit, ...invalid] });
  assert.equal(result.status, 'failed');
  assert.equal(result.invalidOutputs, invalid.length);
  assert.deepEqual(result.hits, [hit]);
});

test('scanner input must be a file in the snapshot', () => {
  for (const file of ['../x.rs', 'missing.rs']) {
    assert.equal(parseSastResult({ exitCode: 0, stdout: JSON.stringify(envelope()), timedOut: false, truncated: false }, file, inventory).status, 'failed');
  }
});

test('static prose is redacted and raw malformed output is never echoed', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nsynthetic fixture\n-----END PRIVATE KEY-----';
  const result = parse({ ...envelope(), hits: [{ ...hit, message: pem }] });
  assert.equal(result.status, 'ok');
  assert.match(result.hits[0]!.message, /REDACTED/);
  assert.ok(!JSON.stringify(result).includes('synthetic fixture'));
  const failure = parseSastResult({ exitCode: 0, timedOut: false, truncated: false, stdout: pem }, 'src/lib.rs', inventory);
  assert.ok(!JSON.stringify(failure).includes('synthetic fixture'));
});
