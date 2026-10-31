/**
 * Pinning: the pin file must live outside the project root, and any edit to a
 * pinned file after pinning has to surface as a named mismatch.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { digestJson } from '../src/digest.ts';
import { pinContract, readPin, refreshPin, verifyPin } from '../src/pin.ts';
import { makeProject, evaluatorConfig } from '../test-support/fixture.ts';

test('pinContract writes a pin outside the root and verifyPin accepts it', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const result = project.pin();
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;

  assert.match(result.pinSet.contractDigest, /^[0-9a-f]{64}$/);
  assert.match(result.pinSet.verifierDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.pinSet.evaluatorConfigDigest, digestJson(project.config));

  const mode = statSync(project.pinFile).mode & 0o777;
  assert.equal(mode, 0o600, 'the pin file should not be world readable');

  const verified = verifyPin(project.pinFile, project.roots);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  if (verified.ok) assert.deepEqual(verified.pinSet, result.pinSet);
});

test('the pin file may not live inside the project root', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const inside = project.pin({
    pinFile: join(project.root, '.oms', 'pin.json'),
  });
  assert.equal(inside.ok, false);
  if (!inside.ok) assert.equal(inside.code, 'E_PATH_INSIDE_ROOT');
  assert.throws(() => readFileSync(join(project.root, '.oms', 'pin.json')));
});

test('editing a verifier file after pinning is a verifier mismatch', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  writeFileSync(project.verifierPath, "// verifier: weakened\ntest.skip('everything');\n");
  const verified = verifyPin(project.pinFile, project.roots);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  const mismatch = verified.mismatches.find((entry) => entry.what === 'verifier');
  assert.ok(mismatch, JSON.stringify(verified.mismatches));
  assert.deepEqual(mismatch.files, ['tests/verifier.test.ts']);
  assert.notEqual(mismatch.expected, mismatch.actual);
});

test('editing task.json after pinning is a contract mismatch', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const closed = project.contract();
  const first = closed.items[0];
  assert.ok(first);
  first.status = 'closed';
  first.evidence = {
    itemId: 'item-1',
    specificationDigest: 'e'.repeat(64),
    codeDigest: 'a'.repeat(64),
    verifierDigest: 'b'.repeat(64),
    snapshotDigest: 'c'.repeat(64),
    mode: 'offline-snapshot',
    passed: true,
    details: 'trust me',
    at: '2026-01-01T00:00:00.000Z',
  };
  project.writeContractRaw(`${JSON.stringify(closed, null, 2)}\n`);

  assert.equal(verifyPin(project.pinFile, project.roots).ok, false);
  const verified = verifyPin(project.pinFile, project.roots);
  if (verified.ok) return;
  assert.ok(verified.mismatches.some((entry) => entry.what === 'contract'));
});

test('a deleted verifier file is reported, not thrown', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const before = readFileSync(project.verifierPath);
  assert.ok(before.length > 0);
  // Replace the file with a directory: the pinned path no longer reads.
  rmSync(project.verifierPath);
  mkdirSync(project.verifierPath);

  const verified = verifyPin(project.pinFile, project.roots);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.ok(verified.mismatches.some((entry) => entry.what === 'verifier'));
});

test('traversal and symlink escapes in verifierPaths are rejected at pin time', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  writeFileSync(join(project.outside, 'secret.ts'), 'outside\n');
  symlinkSync(join(project.outside, 'secret.ts'), join(project.root, 'tests', 'evil.test.ts'));

  const traversal = project.pin({ verifierPaths: ['../outside/secret.ts'] });
  assert.equal(traversal.ok, false);
  if (!traversal.ok) assert.equal(traversal.code, 'E_PATH_ESCAPE');

  const absolute = project.pin({ verifierPaths: [join(project.root, 'tests', 'verifier.test.ts')] });
  assert.equal(absolute.ok, false);
  if (!absolute.ok) assert.equal(absolute.code, 'E_ABSOLUTE_PATH');

  const symlink = project.pin({ verifierPaths: ['tests/evil.test.ts'] });
  assert.equal(symlink.ok, false);
  if (!symlink.ok) assert.equal(symlink.code, 'E_SYMLINK_ESCAPE');

  const noVerifier = project.pin({ verifierPaths: [] });
  assert.equal(noVerifier.ok, false);
  if (!noVerifier.ok) assert.equal(noVerifier.code, 'E_NO_VERIFIER');

  const badConfig = project.pin({ evaluatorConfig: { schema: 'oms.evaluator/0' } });
  assert.equal(badConfig.ok, false);
  if (!badConfig.ok) assert.equal(badConfig.code, 'E_CONFIG_INVALID');
});

test('refreshPin updates only the contract digest after an allowed edit', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const before = readPin(project.pinFile);
  assert.equal(before.ok, true);
  if (!before.ok) return;

  const contract = project.contract();
  const second = contract.items[1];
  assert.ok(second);
  second.status = 'active';
  contract.items[0]!.status = 'open';
  project.setContract(contract);

  const after = readPin(project.pinFile);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.notEqual(after.value.pin.contractDigest, before.value.pin.contractDigest);
  assert.equal(after.value.pin.verifierDigest, before.value.pin.verifierDigest);
  assert.equal(after.value.pin.evaluatorConfigDigest, before.value.pin.evaluatorConfigDigest);
  assert.equal(verifyPin(project.pinFile, project.roots).ok, true);
});

test('a missing or corrupt pin file is a pinFile mismatch', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const missing = verifyPin(join(project.outside, 'nope.json'), project.roots);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.mismatches[0]?.what, 'pinFile');

  writeFileSync(project.pinFile, '{"schema":"oms.pin/0"}\n');
  const corrupt = verifyPin(project.pinFile, project.roots);
  assert.equal(corrupt.ok, false);
  if (!corrupt.ok) assert.equal(corrupt.mismatches[0]?.what, 'pinFile');

  const read = readPin(project.pinFile);
  assert.equal(read.ok, false);

  const refreshed = refreshPin(project.pinFile, project.roots);
  assert.equal(refreshed.ok, false);
});

test('a pin file with an inconsistent internal digest is refused', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const pin = project.readPinFile();
  pin.pin.contractDigest = 'f'.repeat(64);
  writeFileSync(project.pinFile, JSON.stringify(pin));
  const read = readPin(project.pinFile);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.ok(read.issues.some((issue) => issue.path === 'contract.digest'));
  }
});

test('pinContract rejects an invalid contract instead of pinning it', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  project.writeContractRaw(`${JSON.stringify({ version: 1, items: [] })}\n`);
  const result = project.pin({ pinFile: join(project.outside, 'pin-invalid.json') });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'E_CONTRACT_INVALID');
  assert.throws(() => readFileSync(join(project.outside, 'pin-invalid.json')));
});

test('pinContract rejects a missing contract or an unusable root', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const missingContract = pinContract({ ...project.roots, contractPath: '.oms/missing.json',
  verifierPaths: ['tests/verifier.test.ts'],
  evaluatorConfig: evaluatorConfig(),
  pinFile: join(project.outside, 'pin-2.json'), });
  assert.equal(missingContract.ok, false);
  if (!missingContract.ok) assert.equal(missingContract.code, 'E_NOT_FOUND');

  const badRoot = pinContract({
    ...project.roots,
    codeRoot: join(project.base, 'nope'),
    contractPath: 'task.json',
    verifierPaths: ['tests/verifier.test.ts'],
    evaluatorConfig: evaluatorConfig(),
    pinFile: join(project.outside, 'pin-3.json'),
  });
  assert.equal(badRoot.ok, false);
  if (!badRoot.ok) assert.equal(badRoot.code, 'E_BAD_ROOT');
});
