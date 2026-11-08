import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/normalize.ts';

test('normalization strips private paths, identifiers, addresses and numbers and is idempotent', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const a = normalize(`error[E0277]: trait bound 'private${seed}' not satisfied at /home/user${seed}/src/lib.rs:42 for 11111111111111111111111111111111`, 'build', 'rustc');
    assert.equal(a.code, 'rustc:E0277');
    assert.ok(!a.normalized.includes(`private${seed}`));
    assert.ok(!a.normalized.includes('/home/'));
    assert.ok(!a.normalized.includes('11111111111111111111111111111111'));
    assert.deepEqual(normalize(a.normalized, 'build', 'rustc'), a);
    assert.equal(a.key, normalize("error[E0277]: trait bound 'another' not satisfied at /tmp/else.rs:99 for 22222222222222222222222222222222", 'build', 'rustc').key);
  }
});
test('uses first error rather than model-like text elsewhere in output', () => {
  const a = normalize('build started\nerror TS2345: argument is incompatible\nerror TS9999: ignored', 'build', 'tsc');
  assert.equal(a.code, 'ts:2345');
  assert.ok(!a.normalized.includes('9999'));
  assert.ok(a.normalized.length <= 240);
});
