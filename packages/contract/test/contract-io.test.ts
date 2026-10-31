/**
 * Contract I/O: atomic writes that never leave a temp file, pure transitions,
 * and the one-active-item invariant.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeFileAtomic } from '../src/atomic.ts';
import {
  ContractError,
  activate,
  applyActivate,
  applyClose,
  applyFailedRun,
  applyPropose,
  applyReopen,
  readContractFile,
  writeContractFileAtomic,
} from '../src/contract-io.ts';
import type { Evidence } from '../src/evidence.ts';
import { FIXED_TIME, baseContract, makeProject } from '../test-support/fixture.ts';

const EVIDENCE: Evidence = {
  itemId: 'item-1',
  specificationDigest: 'e'.repeat(64),
  codeDigest: 'a'.repeat(64),
  verifierDigest: 'b'.repeat(64),
  snapshotDigest: 'c'.repeat(64),
  mode: 'offline-snapshot',
  passed: true,
  details: 'ok',
  at: FIXED_TIME.toISOString(),
};

function tempFiles(directory: string): string[] {
  return readdirSync(directory).filter((entry) => entry.includes('.tmp-'));
}

test('writeFileAtomic replaces the file content and leaves no temp file', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const target = join(project.outside, 'value.json');

  writeFileAtomic(target, '{"a":1}\n');
  writeFileAtomic(target, '{"a":2}\n');
  assert.equal(readFileSync(target, 'utf8'), '{"a":2}\n');
  assert.deepEqual(tempFiles(project.outside), []);

  const nested = join(project.outside, 'deep', 'dir', 'value.json');
  writeFileAtomic(nested, 'ok\n');
  assert.equal(readFileSync(nested, 'utf8'), 'ok\n');
});

test('a failed atomic write leaves no temp file behind', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  // Renaming a file over an existing directory fails on every POSIX system.
  const target = join(project.outside, 'is-a-directORY');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'keep\n');

  assert.throws(() => writeFileAtomic(target, 'nope\n'));
  assert.deepEqual(tempFiles(project.outside), [], 'no temp file may survive a failed write');
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep\n');
});

test('writing an invalid contract throws instead of persisting it', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const before = readFileSync(project.contractPath, 'utf8');

  const invalid = baseContract();
  invalid.version = 1 as unknown as 0;
  assert.throws(
    () => writeContractFileAtomic(project.contractPath, invalid),
    (error: unknown) => error instanceof ContractError && error.code === 'E_INVALID_CONTRACT',
  );
  assert.equal(readFileSync(project.contractPath, 'utf8'), before);
  assert.deepEqual(tempFiles(join(project.root, '.oms')), []);
});

test('readContractFile reports a missing or broken task.json', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const missing = readContractFile(join(project.root, '.oms', 'nope.json'));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.issues[0]?.code, 'E_CONTRACT_MISSING');

  project.writeContractRaw('{');
  const broken = readContractFile(project.contractPath);
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(broken.issues[0]?.code, 'E_INVALID_JSON');
});

test('activate() enforces one active item', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  // item-1 is active in the fixture, so activating item-2 must fail.
  const refused = activate(project.contractPath, 'item-2');
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.issues[0]?.code, 'E_ALREADY_ACTIVE');

  const same = activate(project.contractPath, 'item-1');
  assert.equal(same.ok, true, 'activating the already-active item is idempotent');

  const unknown = activate(project.contractPath, 'item-9');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.issues[0]?.code, 'E_UNKNOWN_ITEM');

  // Close item-1, then item-2 can become active.
  const proposed = applyPropose(project.contract(), 'item-1');
  assert.ok(proposed.ok);
  if (!proposed.ok) return;
  const closed = applyClose(proposed.contract, 'item-1', EVIDENCE);
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  project.setContract(closed.contract);
  const activated = activate(project.contractPath, 'item-2');
  assert.equal(activated.ok, true, JSON.stringify(activated.ok ? null : activated.issues));
  if (activated.ok) {
    const statuses = activated.value.items.map((item) => [item.id, item.status]);
    assert.deepEqual(statuses, [
      ['item-1', 'closed'],
      ['item-2', 'active'],
    ]);
  }

  const closedItem = applyActivate(project.contract(), 'item-1');
  assert.equal(closedItem.ok, false);
  if (!closedItem.ok) assert.equal(closedItem.code, 'E_ITEM_CLOSED');
});

test('applyPropose only moves an active item to proposed', () => {
  const contract = baseContract();
  const proposed = applyPropose(contract, 'item-1');
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  assert.equal(proposed.contract.items[0]?.status, 'proposed');
  assert.equal(contract.items[0]?.status, 'active', 'the input contract is not mutated');

  const open = applyPropose(contract, 'item-2');
  assert.equal(open.ok, false);
  if (!open.ok) assert.equal(open.code, 'E_ITEM_NOT_ACTIVE');

  const unknown = applyPropose(contract, 'item-9');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, 'E_UNKNOWN_ITEM');
});

test('applyClose refuses forked, failing and mismatched evidence', () => {
  const proposed = applyPropose(baseContract(), 'item-1');
  assert.ok(proposed.ok);
  if (!proposed.ok) return;
  const contract = proposed.contract;

  for (const [patch, code] of [
    [{ mode: 'forked' }, 'E_BAD_EVIDENCE'],
    [{ passed: false }, 'E_BAD_EVIDENCE'],
    [{ itemId: 'item-2' }, 'E_BAD_EVIDENCE'],
  ] as const) {
    const result = applyClose(contract, 'item-1', { ...EVIDENCE, ...patch });
    assert.equal(result.ok, false, JSON.stringify(patch));
    if (!result.ok) assert.equal(result.code, code);
  }

  const notProposed = applyClose(baseContract(), 'item-1', EVIDENCE);
  assert.equal(notProposed.ok, false);
  if (!notProposed.ok) assert.equal(notProposed.code, 'E_ITEM_NOT_PROPOSED');

  const closed = applyClose(contract, 'item-1', EVIDENCE);
  assert.equal(closed.ok, true);
  if (closed.ok) {
    assert.equal(closed.contract.items[0]?.status, 'closed');
    assert.deepEqual(closed.contract.items[0]?.evidence, EVIDENCE);
  }
});

test('applyFailedRun increments, then blocks at the cap', () => {
  const proposed = applyPropose(baseContract(), 'item-1');
  assert.ok(proposed.ok);
  if (!proposed.ok) return;

  const first = applyFailedRun(proposed.contract, 'item-1', 2);
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.deepEqual(first.value, { reopenCount: 1, blocked: false });
  assert.equal(first.contract.items[0]?.status, 'active');

  const again = applyPropose(first.contract, 'item-1');
  assert.ok(again.ok);
  if (!again.ok) return;
  const second = applyFailedRun(again.contract, 'item-1', 2);
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.deepEqual(second.value, { reopenCount: 2, blocked: true });
  assert.equal(second.contract.items[0]?.status, 'blocked');
});

test('applyReopen clears the closure evidence', () => {
  const proposed = applyPropose(baseContract(), 'item-1');
  assert.ok(proposed.ok);
  if (!proposed.ok) return;
  const closed = applyClose(proposed.contract, 'item-1', EVIDENCE);
  assert.ok(closed.ok);
  if (!closed.ok) return;

  const reopened = applyReopen(closed.contract, 'item-1');
  assert.ok(reopened.ok);
  if (!reopened.ok) return;
  assert.equal(reopened.contract.items[0]?.status, 'active');
  assert.equal(reopened.contract.items[0]?.evidence, undefined);

  const open = applyReopen(baseContract(), 'item-2');
  assert.equal(open.ok, false);
  if (!open.ok) assert.equal(open.code, 'E_ITEM_NOT_REOPENABLE');
});
