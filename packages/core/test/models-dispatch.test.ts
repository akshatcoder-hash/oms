import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDispatchAllocator, type DispatchRole } from '../src/models/dispatch.ts';
import { MODEL_POLICY_VERSION } from '../src/models/catalog.ts';

const model = { provider: 'openai', modelId: 'gpt-6.1-sol', endpointId: 'https://api.openai.com/v1' };

test('one allocator orders every tool continuation within the same turn', () => {
  const allocate = createDispatchAllocator();
  const roles: DispatchRole[] = ['worker', 'worker', 'worker', 'worker'];
  const identities = roles.map((role) => allocate('turn', role, model));
  assert.deepEqual(
    identities.map((identity) => identity.attempt),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    identities.map((identity) => identity.role),
    roles,
  );
  assert.equal(new Set(identities.map((identity) => identity.dispatchId)).size, roles.length);
  for (const identity of identities) {
    assert.match(identity.dispatchId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(identity.logicalTurnId, 'turn');
    assert.equal(identity.policyVersion, MODEL_POLICY_VERSION);
    assert.equal(identity.endpointId, model.endpointId);
    assert.equal(identity.modelId, model.modelId);
  }
  assert.equal(allocate('another-turn', 'worker', model).attempt, 1);
});

test('restored allocations advance beyond every historical reservation without mutating the seed', () => {
  const previous = Object.freeze(
    [
      { logicalTurnId: 'turn', attempt: 8 },
      { logicalTurnId: 'turn', attempt: 3 },
      { logicalTurnId: 'other', attempt: 2 },
    ].map((reservation) => Object.freeze(reservation)),
  );
  const allocate = createDispatchAllocator(previous);
  assert.equal(allocate('turn', 'worker', model).attempt, 9);
  assert.equal(allocate('turn', 'worker', model).attempt, 10);
  assert.equal(allocate('other', 'worker', model).attempt, 3);
  assert.equal(previous.length, 3);
});

test('invalid seed or exhausted attempt range fails closed rather than reusing an attempt', () => {
  for (const attempt of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createDispatchAllocator([{ logicalTurnId: 'turn', attempt }]));
  }
  assert.throws(() => createDispatchAllocator([{ logicalTurnId: '', attempt: 1 }]));
  const allocate = createDispatchAllocator([{ logicalTurnId: 'turn', attempt: Number.MAX_SAFE_INTEGER }]);
  assert.throws(() => allocate('turn', 'worker', model));
  assert.throws(() => allocate('', 'worker', model));
  assert.throws(() => allocate('new', 'router' as never, model));
  assert.throws(() => allocate('new', 'worker', { ...model, endpointId: '' }));
  assert.equal(allocate('new', 'worker', model).attempt, 1);
});
