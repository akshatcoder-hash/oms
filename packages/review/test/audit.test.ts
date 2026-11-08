import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIT_OUTPUT_BYTES, parseAuditResult } from '../src/static/audit.ts';

const inventory = new Map([['Cargo.lock', 6]]);
const entry = () => ({ advisory: { id: 'RUSTSEC-2026-0144', package: 'anchor-lang', title: 'Dependency advisory', informational: null, withdrawn: null }, package: { name: 'anchor-lang', version: '1.0.1' } });
const envelope = (list: unknown[] = [entry()]) => ({ database: {}, lockfile: {}, settings: { target_arch: [], target_os: [], severity: null, ignore: [], informational_warnings: ['unmaintained', 'unsound', 'notice'] }, vulnerabilities: { found: list.length > 0, count: list.length, list }, warnings: {} });
function parse(value: unknown, exitCode = 1) {
  return parseAuditResult({ exitCode, stdout: JSON.stringify(value), timedOut: false, truncated: false }, 'Cargo.lock', inventory);
}

test('audit exit 1 with consistent advisories is a successful scan, never confirmation', () => {
  const result = parse(envelope());
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.hits, [{ tool: 'cargo-audit', ruleId: 'RUSTSEC-2026-0144', class: 'dependency-advisory', severity: 'high', location: { file: 'Cargo.lock', line: 1 }, message: 'anchor-lang 1.0.1: Dependency advisory' }]);
  assert.deepEqual(parse(envelope([]), 0), { status: 'ok', hits: [], invalidOutputs: 0 });
  assert.equal('coverage' in result, false);
});

test('audit crashes and malformed, oversized or truncated output fail closed', () => {
  const base = { exitCode: 1, stdout: JSON.stringify(envelope()), timedOut: false, truncated: false };
  for (const change of [{ exitCode: 2 }, { exitCode: null }, { timedOut: true }, { truncated: true }, { stdout: '' }, { stdout: '{broken' }, { stdout: 'é'.repeat(AUDIT_OUTPUT_BYTES / 2 + 1) }]) {
    const result = parseAuditResult({ ...base, ...change }, 'Cargo.lock', inventory);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.hits, []);
  }
  for (const file of ['../Cargo.lock', '/Cargo.lock', 'missing.lock']) {
    assert.equal(parseAuditResult(base, file, inventory).status, 'failed');
  }
});

test('audit envelopes and count, found and exit-code consistency are enforced', () => {
  for (const value of [null, {}, { ...envelope(), extra: true }, { ...envelope(), warnings: null },
    ...[{ found: false }, { count: 0 }, { count: -1 }, { list: null }].map(change => ({ ...envelope(), vulnerabilities: { ...envelope().vulnerabilities, ...change } })),
  ]) assert.equal(parse(value).status, 'failed');
  assert.equal(parse(envelope(), 0).status, 'failed');
  assert.equal(parse(envelope([]), 1).status, 'failed');
});

test('invalid audit entries are counted while valid advisories survive', () => {
  const invalid = [null, {},
    ...[{ id: '../escape' }, { package: 'other' }, { title: 'é'.repeat(2049) }, { informational: 'notice' }, { withdrawn: '2026-01-01' }].map(change => ({ ...entry(), advisory: { ...entry().advisory, ...change } })),
    { ...entry(), package: { name: 'anchor-lang', version: 'bad\nversion' } },
  ];
  const result = parse(envelope([entry(), ...invalid]));
  assert.equal(result.status, 'failed');
  assert.equal(result.invalidOutputs, invalid.length);
  assert.equal(result.hits.length, 1);
});

test('unmaintained or unsound warnings are reported but do not fail the audit', () => {
  const result = parse({ ...envelope([]), warnings: { unmaintained: [entry()], unsound: [entry()] } }, 0);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.hits, []);
  assert.match(result.reason!, /2 .*warning/);
});

test('audit prose is redacted and unused fields never escape into reports', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nsynthetic fixture\n-----END PRIVATE KEY-----';
  const item = entry();
  item.advisory.title = pem;
  const result = parse(envelope([{ ...item, unused: pem }]));
  assert.equal(result.status, 'ok');
  assert.match(result.hits[0]!.message, /REDACTED/);
  assert.ok(!JSON.stringify(result).includes('synthetic fixture'));
});

test('audit filters cannot silently omit advisories', () => {
  for (const change of [{ ignore: ['RUSTSEC-2026-0144'] }, { severity: 'critical' },
    { target_arch: ['x86_64'] }, { target_os: ['linux'] }, { extra: true }]) {
    const value = envelope([]);
    assert.equal(parse({ ...value, settings: { ...value.settings, ...change } }, 0).status, 'failed');
  }
});
