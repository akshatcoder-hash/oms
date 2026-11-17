/**
 * The pin-aware store is the engine's entry point for contract writes: it
 * refuses to clobber a contract the pin no longer matches.
 */

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createContractStore } from '../src/store.ts';
import { makeProject } from '../test-support/fixture.ts';

test('the store reads the contract recorded in the pin', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const store = createContractStore({ ...project.roots, pinFile: project.pinFile });

  assert.equal(store.contractPath(), 'task.json');
  const read = store.read();
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.value.items.length, 2);
  assert.equal(store.verify().ok, true);
});

test('the store enforces one active item on activate', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const store = createContractStore({ ...project.roots, pinFile: project.pinFile });

  const refused = store.activate('item-2');
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(String(refused.code), 'E_ALREADY_ACTIVE');

  const ok = store.activate('item-1');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // The store re-pins after its own write, so the pin still verifies.
  assert.equal(store.verify().ok, true);
});

test('the store refuses to write over a contract edited behind its back', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const store = createContractStore({ ...project.roots, pinFile: project.pinFile });

  writeFileSync(project.contractPath, project.readContractText().replace('"active"', '"proposed"'));

  const refused = store.activate('item-1');
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(String(refused.code), 'E_PIN_MISMATCH');
    assert.ok(refused.mismatches?.some((mismatch) => mismatch.what === 'contract'));
  }
});

test('the store reports a missing pin and a missing contract without throwing', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const noPin = createContractStore({ ...project.roots, pinFile: join(project.outside, 'missing-pin.json') });
  assert.equal(noPin.contractPath(), null);
  const read = noPin.read();
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.issues[0]?.code, 'E_PIN_UNREADABLE');

  const store = createContractStore({ ...project.roots, pinFile: project.pinFile });
  rmSync(project.contractPath);
  const missing = store.mutate((contract) => ({ ok: true, contract, value: undefined }));
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(String(missing.code), 'E_PIN_MISMATCH');
    assert.ok(missing.mismatches?.some((mismatch) => mismatch.what === 'contract'));
  }
});

test('a refused mutation leaves the contract untouched', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const store = createContractStore({ ...project.roots, pinFile: project.pinFile });
  const before = project.readContractText();

  const refused = store.activate('item-2');
  assert.equal(refused.ok, false);
  assert.equal(project.readContractText(), before);
});
